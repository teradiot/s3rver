'use strict';

var FileStore = require('./file-store'),
    templateBuilder = require('./xml-template-builder'),
    concat = require('concat-stream'),
    xml2js = require('xml2js'),
    async = require('async'),
    path = require('path'),
    ReadableStream = require('stream').Readable;

module.exports = function (rootDirectory, logger, indexDocument, errorDocument, fs, routingRule) {
  var fileStore = new FileStore(rootDirectory, fs);

  var buildXmlResponse = function (res, status, template) {
    res.header('Content-Type', 'application/xml');
    res.status(status);
    return res.send(template);
  };

  var buildResponse = function (req, res, status, object, data) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Etag', '"' + object.md5 + '"');
    res.header('Last-Modified', new Date(object.modifiedDate).toUTCString());
    res.header('Content-Type', object.contentType);

    if (object.contentEncoding)
      res.header('Content-Encoding', object.contentEncoding);

    if (object.contentDisposition)
      res.header('Content-Disposition', object.contentDisposition);

    if (data.range) {
      var end = Math.min(data.range.end || Infinity, object.size - 1);
      res.header('Content-Range', 'bytes ' + data.range.start + '-' + end + '/' + object.size);
      res.header('Accept-Ranges', 'bytes');
      res.header('Content-Length', end - data.range.start + 1);
    }
    else {
      res.header('Content-Length', object.size);
    }

    if (object.customMetaData.length > 0) {
      object.customMetaData.forEach(function (metaData) {
        res.header(metaData.key, metaData.value);
      });
    }
    res.status(status);
    if (req.method === 'HEAD') {
      return res.end();
    }
    return data.pipe(res);
  };

  var errorResponse = function (req, res, keyName) {
    logger.error('Object "%s" in bucket "%s" does not exist', keyName, req.bucket.name);

    if (indexDocument) {
      if (errorDocument) {
        fileStore.getObject(req.bucket, errorDocument, function (err, object, data) {
          if (err) {
            console.error('Custom Error Document not found: ' + errorDocument);
            return notFoundResponse(req, res);
          }
          else {
            return buildResponse(req, res, 404, object, data);
          }
        });
      }
      else {
        return notFoundResponse(req, res);
      }
    }
    else {
      var template = templateBuilder.buildKeyNotFound(keyName);
      return buildXmlResponse(res, 404, template);
    }
  };


  var notFoundResponse = function (req, res) {
    var ErrorDoc = '<!DOCTYPE html>\n<html><head><title>404 - Resource Not Found</title></head><body><h1>404 - Resource Not Found</h1></body></html>';
    var stream = new ReadableStream();
    stream.push(ErrorDoc);
    stream.push(null);

    return buildResponse(req, res, 404, {
      modifiedDate: new Date(),
      contentType: 'text/html',
      customMetaData: [],
      size: ErrorDoc.length
    }, stream);
  };

  var deleteObjects = function (req, res) {
    xml2js.parseString(req.body, function (err, parsedBody) {
      var keys = parsedBody.Delete.Object.map(function (o) {
        return o.Key[0];
      });
      async.each(keys, function (key, cb) {
          fileStore.getObjectExists(req.bucket, key, function (err) {
            if (err) {
              var template = templateBuilder.buildKeyNotFound(key);
              cb(err);
              return buildXmlResponse(res, 404, template);
            }
            cb();
          });
        },
        function done(err) {
          if (err) return;
          async.each(keys, function (key, cb) {
              fileStore.deleteObject(req.bucket, key, function (err) {
                if (err) {
                  logger.error('Could not delete object "%s"', key, err);
                  var template = templateBuilder.buildError('InternalError',
                    'We encountered an internal error. Please try again.');
                  cb(err);
                  return buildXmlResponse(res, 500, template);
                }
                logger.info('Deleted object "%s" in bucket "%s"', key, req.bucket.name);
                cb();
              });
            },
            function done(err) {
              if (err) return;
              var template = templateBuilder.buildObjectsDeleted(keys);
              return buildXmlResponse(res, 200, template);
            });
        });
    });
  };

  /**
   * The following methods correspond the S3 api. For more information visit:
   * http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
   */
  return {
    /**
     * Middleware to check if a bucket exists
     */
    bucketExists: function (req, res, next) {
      var bucketName = req.params.bucket;
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (err) {
          logger.error('No bucket found for "%s"', bucketName);
          var template = templateBuilder.buildBucketNotFound(bucketName);
          return buildXmlResponse(res, 404, template);
        }
        req.bucket = bucket;
        return next();
      });
    },
    getBuckets: function (req, res) {
      var buckets = fileStore.getBuckets();
      logger.info('Fetched %d buckets', buckets.length);
      var template = templateBuilder.buildBuckets(buckets);
      return buildXmlResponse(res, 200, template);
    },
    getBucket: function (req, res) {

      var options = {
        marker: req.query.marker || null,
        prefix: req.query.prefix || null,
        maxKeys: parseInt(req.query['max-keys']) || 1000,
        delimiter: req.query.delimiter || null
      };

      if (indexDocument) {
        fileStore.getObject(req.bucket, indexDocument, function (err, object, data) {
          if (err) {
            return errorResponse(req, res, indexDocument);
          }
          else {
            logger.info('Serving Page: %s', object.key);
            return buildResponse(req, res, 200, object, data);
          }
        });
      }
      else {
        logger.info('Fetched bucket "%s" with options %s', req.bucket.name, options);
        fileStore.getObjects(req.bucket, options, function (err, results) {
          logger.info('Found %d objects for bucket "%s"', results.objects.length, req.bucket.name);
          var template = templateBuilder.buildBucketQuery(options, results);
          return buildXmlResponse(res, 200, template);
        });
      }
    },
    putBucket: function (req, res) {
      var bucketName = req.params.bucket;
      var template;
      /**
       * Derived from http://docs.aws.amazon.com/AmazonS3/latest/dev/BucketRestrictions.html
       */
      if ((/^[a-z0-9]+(.?[-a-z0-9]+)*$/.test(bucketName) === false)) {
        template = templateBuilder.buildError('InvalidBucketName',
            'Bucket names can contain lowercase letters, numbers, and hyphens. ' +
            'Each label must start and end with a lowercase letter or a number.');
        logger.error('Error creating bucket "%s" because the name is invalid', bucketName);
        return buildXmlResponse(res, 400, template);
      }
      if (bucketName.length < 3 || bucketName.length > 63) {
        logger.error('Error creating bucket "%s" because the name is invalid', bucketName);
        template = templateBuilder.buildError('InvalidBucketName',
          'The bucket name must be between 3 and 63 characters.');
        return buildXmlResponse(res, 400, template);
      }
      fileStore.getBucket(bucketName, function (err, bucket) {
        if (bucket) {
          logger.error('Error creating bucket. Bucket "%s" already exists', bucketName);
          var template = templateBuilder.buildError('BucketAlreadyExists',
            'The requested bucket already exists');
          return buildXmlResponse(res, 409, template);
        }
        fileStore.putBucket(bucketName, function (err) {
          if (err) {
            logger.error('Error creating bucket "%s"', err);
            var template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Created new bucket "%s" successfully', bucketName);
          res.header('Location', '/' + bucketName);
          return res.status(200).send();
        });
      });
    },
    deleteBucket: function (req, res) {
      fileStore.deleteBucket(req.bucket, function (err) {
        if (err) {
          var template = templateBuilder.buildBucketNotEmpty(req.bucket.name);
          return buildXmlResponse(res, 409, template);
        }
        return res.status(204).end();
      });
    },
    getObject: function (req, res) {
      var keyName = req.params.key;
      var acl = req.query.acl;
      if (acl !== undefined) {
        var template = templateBuilder.buildAcl();
        return buildXmlResponse(res, 200, template);
      }
      fileStore.getObject(req.bucket, keyName, req.headers.range, function (err, object, data) {
        if (err) {
          if (routingRule) {
            var [host, port] = routingRule.Redirect.HostName.split(':');
            host = host || req.hostname;
            var hostname = host + ':' + port;
            var location = routingRule.Redirect.Protocol +
                           '://' +
                           hostname +
                           '/' +
                           routingRule.Redirect.ReplaceKeyPrefixWith +
                           keyName;
            logger.info('Redirect object "%s" in bucket "%s" to "%s"', keyName, req.bucket.name, location);
            res.header('Location', location);
            res.header('Content-Length', 0);
            return res.status(routingRule.Redirect.HttpRedirectCode).end();
          }

          if (indexDocument) {
            keyName = path.join(keyName, indexDocument);
            return fileStore.getObject(req.bucket, keyName, function (err, object, data) {
              if (err) {
                return errorResponse(req, res, keyName);
              }
              else {
                return buildResponse(req, res, 200, object, data);
              }
            });
          }
          else {
            return errorResponse(req, res, keyName);
          }
        }

        var noneMatch = req.headers['if-none-match'];
        if (noneMatch && (noneMatch === '"' + object.md5 + '"' || noneMatch === '*')) {
          return res.status(304).end();
        }
        var modifiedSince = req.headers['if-modified-since'];
        if (modifiedSince) {
          var time = new Date(modifiedSince);
          var modifiedDate = new Date(object.modifiedDate);
          if (time >= modifiedDate) {
            return res.status(304).end();
          }
        }

        return buildResponse(req, res, req.headers.range ? 206 : 200, object, data);
      });
    },
    postObject: function (req, res) {
      fileStore.postObject(req.bucket, req, function (err, key) {
        if (err) {
          logger.error('Error uploading object "%s" to bucket "%s"',
                       req.body.key, req.bucket.name, err);
          var template = templateBuilder.buildError('InternalError',
                                                    'We encountered an internal error. Please try again.');
          return buildXmlResponse(res, 500, template);
        }
        logger.info('Stored object "%s" in bucket "%s" successfully', req.body.key, req.bucket.name);
        res.header('ETag', '"' + key.md5 + '"');
        return res.status(200).end();
      });

    },
    putObject: function (req, res) {
      var template;
      var copy = req.headers['x-amz-copy-source'];
      if (copy) {
        copy = copy.charAt(0) === '/' ? copy : '/' + copy
        var srcObjectParams = copy.split('/'),
            srcBucket = srcObjectParams[1],
            srcObject = srcObjectParams.slice(2).join('/');
        fileStore.getBucket(srcBucket, function (err, bucket) {
          if (err) {
            logger.error('No bucket found for "%s"', srcBucket);
            template = templateBuilder.buildBucketNotFound(srcBucket);
            return buildXmlResponse(res, 404, template);
          }
          fileStore.getObject(bucket, srcObject, function (err) {
            if (err) {
              logger.error('Object "%s" in bucket "%s" does not exist', srcObject, bucket.name);
              template = templateBuilder.buildKeyNotFound(srcObject);
              return buildXmlResponse(res, 404, template);
            }

            var replaceMetadata = req.headers['x-amz-metadata-directive'] === 'REPLACE';
            fileStore.copyObject({
              request: req,
              srcKey: srcObject,
              srcBucket: bucket,
              destBucket: req.bucket,
              destKey: req.params.key,
              replaceMetadata: replaceMetadata

            }, function (err, key) {
              if (err) {
                logger.error('Error copying object "%s" from bucket "%s" into bucket "%s" with key of "%s"',
                  srcObject, bucket.name, req.bucket.name, req.params.key);
                template = templateBuilder.buildError('InternalError',
                  'We encountered an internal error. Please try again.');
                return buildXmlResponse(res, 500, template);
              }

              logger.info('Copied object "%s" from bucket "%s"  into bucket "%s" with key of "%s"',
                srcObject, bucket.name, req.bucket.name, req.params.key);
              template = templateBuilder.buildCopyObject(key);
              return buildXmlResponse(res, 200, template);
            });
          });
        });
      }
      else {
        fileStore.putObject(req.bucket, req, function (err, key) {
          if (err) {
            logger.error('Error uploading object "%s" to bucket "%s"',
              req.params.key, req.bucket.name, err);
            var template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Stored object "%s" in bucket "%s" successfully', req.params.key, req.bucket.name);
          res.header('ETag', '"' + key.md5 + '"');
          return res.status(200).end();
        });
      }
    },
    deleteObject: function (req, res) {
      var key = req.params.key;
      fileStore.getObjectExists(req.bucket, key, function (err) {
        if (err) {
          var template = templateBuilder.buildKeyNotFound(key);
          return buildXmlResponse(res, 404, template);
        }
        fileStore.deleteObject(req.bucket, key, function (err) {
          if (err) {
            logger.error('Could not delete object "%s"', key, err);
            var template = templateBuilder.buildError('InternalError',
              'We encountered an internal error. Please try again.');
            return buildXmlResponse(res, 500, template);
          }
          logger.info('Deleted object "%s" in bucket "%s"', key, req.bucket.name);
          return res.status(204).end();
        });
      });
    },
    genericPost: function (req, res) {
      if (req.query.delete !== undefined)
        req.pipe(concat(function (data) {
          req.body = data;
          deleteObjects(req, res);
        }));
      else
        notFoundResponse(req, res);
    }
  };
};
