const s3 = require('s3');
const debug = require('debug');
const _ = require('lodash');
const Promise = require('bluebird');
const request = require('request');

const log = debug('yb-automator:slackReporter:INFO');

/**
 * reportToSlack - This method will send a post request
 * on webhook of slack.
 * @param  {Object} text contains message details.
 * @param  {string} options slack options
 * @return  {Promise} Promise will return promise for completing http request.
 */
function reportToSlack(text, options) {
  return new Promise((resolve, reject) => {
    request({
      uri: options.webhookURL,
      method: 'POST',
      json: {
        text,
      },
    }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * send - This method send the report in slack channel
 * @param  {Object} data is an object containing details of error.
 * @param  {Strign} options automator options
 */
module.exports = function send(data, options) {
  return new Promise((resolve, reject) => {
    try {
      let text = null;

      const awsParams = {
        Bucket: options.aws.s3.bucket + '/' + options.aws.s3.folder,
        Key: data.filePath.replace(/^.*[/\\]([^/\\]+)$/g, '$1'),
        ACL: 'public-read',
      };

      const s3Client = s3.createClient({
        s3Options: {
          region: options.aws.region,
          accessKeyId: options.aws.accessKeyId,
          secretAccessKey: options.aws.secretAccessKey,
        },
      });

      const params = {
        localFile: data.filePath,
        s3Params: awsParams,
      };

      const uploader = s3Client.uploadFile(params);

      uploader.on('error', reject);

      uploader.on('end', () => {
        const imgUrl = [options.aws.s3.path, options.aws.s3.bucket, options.aws.s3.folder, awsParams.Key].join('/');

        log(`done uploading: ${imgUrl}`);

        text = [
          data.description || '_Automation has failed_\n',
          _.map(Object.keys(data.details), (v) => {
            return `*${v}*: ${data.details[v]}`;
          }).join('\n'),
          `\n*Screenshot*: ${imgUrl}`,
        ].join('\n');

        reportToSlack(text, {
          webhookURL: options.slack.webhookURL
        }).then(resolve, reject);
      });
    } catch (err) {
      reject(err);
    }
  });
};
