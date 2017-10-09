const Graph = require('gonitely-graph');
const Promise = require('bluebird');
const debug = require('debug');
const _ = require('lodash');
const YbChromeless = require('yb-chromeless').default;
const request = require('request');
const webdriverio = require('webdriverio');
const base64img = require('base64-img');

const elog = debug('yb-automator:ERROR');
const log = debug('yb-automator:LOG');

module.exports = class automator {
  constructor(options) {
    this.options = _.assign({
      browser: {
        size: {
          width: 1366,
          height: 768,
        },
      },
    }, options);
    this.options.driver = options.driver || automator.DRIVER_WEBDRIVERIO;
    this.errors = [];
    this.graph = new Graph(this.options, {
      nodes: 'steps',
      edges: 'paths',
    });

    switch (this.options.driver) {
      case automator.DRIVER_WEBDRIVERIO:
        {
          this.browser = webdriverio.remote({
            desiredCapabilities: {
              browserName: 'chrome',
              acceptSslCerts: true,
              platform: 'LINUX',
            },
            logLevel: 'debug',
            host: this.options.webdriver.host,
            port: this.options.webdriver.port,
          });
          this.browser.on('error', err => elog(err));
          break;
        }
      default:
        break;
    }
  }

  static get DRIVER_CHROMELESS() {
    return 1;
  }

  static get DRIVER_WEBDRIVERIO() {
    return 2;
  }

  startWebdriverioSession() {
    return new Promise((_resolve, _reject) => {
      this.browser.init().then((info) => {
        this.browser.setViewportSize(this.options.browser.size);

        this.options.sessionId = info.sessionId;
        log(`[session] ${this.options.sessionId} started`);

        _resolve(info.sessionId);
      }, _reject);
    });
  }

  startYbChromelessSession() {
    return new Promise((_resolve, _reject) => {
      // call browser broker
      request({
        uri: `http://${this.options.broker.host}/browse/${this.options.id}`,
        method: 'POST',
        json: {
          proxy: this.options.broker.proxy,
        },
      }, (err, response, body) => {
        if (err) {
          elog(err);
          _reject(err);
        } else {
          // we've got a session
          const session = body;

          log('[session]' + JSON.stringify(session));

          this.browser = new YbChromeless({
            debug: true,
            implicitWait: true,
            scrollBeforeClick: true,
            cdp: {
              host: this.options.broker.host,
              port: session.port,
              secure: true,
              closeTab: false,
            },
            viewport: this.options.browser.size,
            userDataDir: session.userDataDir,
          });

          this.options.sessionId = session.id;

          _resolve(session.id);
        }
      });
    });
  }

  /**
   * run - description
   *
   * @param  {string} sessionId = null A browser's session ID
   * @param  {string} uname = null     An unique descriptive name for this automator instance
   * @return {type}                  description
   */
  run(sessionId = null, uname = null) {
    this.options.id = uname === null ? Math.ceil(Date.now() * Math.random() * 10) : uname;

    return new Promise((resolve, reject) => {
      const initStep = this.options.steps[0];
      const initNode = this.graph.getNode(initStep.name);

      switch (this.options.driver) {
        case automator.DRIVER_WEBDRIVERIO:
          {
            log('Using webdriverio driver');

            this.browser.sessions().then((sessions) => {
              if (sessions.value && sessions.value.length > 0) {
                const sessionExists = _.find(sessions.value, session => session.id === sessionId);

                if (sessionExists) {
                  this.browser.session('get', sessionId).then(() => {
                    this.browser.requestHandler.sessionID = sessionId;
                    this.options.sessionId = sessionId;

                    log(`session ${this.options.sessionId} restored`);

                    this.processSteps(initNode, true).then(resolve, reject);
                  }, () => {
                    this.startWebdriverioSession().then(() => {
                      this.processSteps(initNode, true).then(resolve, reject);
                    });
                  });
                } else {
                  this.startWebdriverioSession().then(() => {
                    this.processSteps(initNode, true).then(resolve, reject);
                  });
                }
              } else {
                this.startWebdriverioSession().then(() => {
                  this.processSteps(initNode, true).then(resolve, reject);
                });
              }
            }, reject);
            break;
          }
        case automator.DRIVER_CHROMELESS:
          {
            log('Using chromeless driver');
            log(this.options.broker);

            this.startYbChromelessSession().then(() => {
              this.processSteps(initNode, true).then((ret) => {
                this.browser.end().then(() => resolve(ret), reject);
              }, reject);
            });
            break;
          }
        default:
          break;
      }
    });
  }

  /**
   * screenshot - description
   *
   * @return {Promise}  Promise which resolves to object like {value: 'base64 encoded image'}
   */
  screenshot() {
    let ret = null;

    switch (this.options.driver) {
      case automator.DRIVER_WEBDRIVERIO:
        {
          ret = this.browser.screenshot();
          break;
        }
      case automator.DRIVER_CHROMELESS:
        {
          ret = new Promise((resolve, reject) => {
            this.browser.screenshot().then((filePath) => {
              base64img.base64(filePath, (err, data) => resolve({
                value: data || null,
              }));
            }, reject);
          });
          break;
        }
      default:
        {
          ret = null;
          break;
        }
    }

    return ret;
  }

  processSteps(step, isFirstStep) {
    const self = this;
    const paths = _.clone(this.options.paths);
    const stepsData = {
      sessionId: this.options.sessionId,
      steps: {},
    };

    if (isFirstStep) {
      paths.unshift({
        to: step.name,
        name: self.graph.outboundEdges(step)[0].name,
      });
    }

    const isLastStep = !paths || paths.length === 0;

    /**
     * Promise.each arbitrarily returns the iterable array, so we need a workaround
     * to return instead the data that is resolved during each step.
     * So, we wrap the .each call inside another Promise which will be resolved with
     * the temporary stepsData container, populated during each step's self resolution.
     */
    return new Promise((resolveFinal, rejectFinal) => {
      if (!isLastStep) {
        return Promise.each(paths, (path) => {
          return new Promise((resolve, reject) => {
            const nextStep = self.graph.getNode(path.to);

            log(`[${path.name}] running step "${nextStep.name}"`);

            return Promise.promisify(nextStep.run, {
              multiArgs: false,
            }).call(self).then((data) => {
              stepsData.steps[nextStep.name] = data;

              resolve();
            }, (err) => {
              reject({
                error: Error(err),
              });
            });
          });
        }).then(() => resolveFinal(stepsData), rejectFinal);
      }

      log(`running step "${step.name}"`);

      return Promise.promisify(step.run, {
        multiArgs: false,
      }).call(self).then((data) => {
        stepsData.steps[step.name] = data;

        resolveFinal(stepsData);
      }, rejectFinal);
    });
  }
};
