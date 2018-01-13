const Graph = require('gonitely-graph');
const Promise = require('bluebird');
const debug = require('debug');
const _ = require('lodash');
const YbChromeless = require('yb-chromeless').default;
const request = require('request');
const webdriverio = require('webdriverio');
const base64img = require('base64-img');
const slackReporter = require('./libs/slackReporter');

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
      headless: true,
      incognito: false,
      vnc: true,
      autoReport: true,
      resetWindow: true,
      reportMethod: 'slack',
    }, options);
    this.options.driver = options.driver || automator.DRIVER_WEBDRIVERIO;
    this.options.persona.message = this.options.persona.message ? this.options.persona.message.replace(/(\r\n|\n|\r)/gm, '\r\n') : null;
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
            logLevel: 'error',
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
          headless: this.options.headless ? 1 : 0,
          incognito: this.options.incognito ? 1 : 0,
          vnc: this.options.vnc ? 1 : 0,
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
            implicitMouseFocus: true,
            scrollBeforeClick: true,
            launchChrome: false,
            cdp: {
              host: this.options.broker.host.replace(/:\d+$/, ''),
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
              this.browser.catch((err) => {
                elog(err);

                if (this.options.autoReport) {
                  log('auto report is enabled');

                  this.report(err).bind(err)
                    .then(reject)
                    .catch(reject);
                }
              });

              this.processSteps(initNode, true).then((ret) => {
                log('steps completed');

                if (this.options.resetWindow) {
                  log('resetting window...');

                  this.resetWindow().then(() => {
                    log('closing browser session');

                    this.browser.end();

                    resolve(ret);
                  }, (err) => {
                    elog(err);

                    this.browser.end();

                    reject(err);
                  });
                } else {
                  this.browser.end();

                  resolve(ret);
                }
              }, reject);
            }, reject);
            break;
          }
        default:
          break;
      }
    });
  }

  resetWindow() {
    const self = this;

    function rp(tab) {
      return new Promise((_resolve, _reject) => {
        request({
          uri: `http://${self.options.broker.host}/close/${self.options.id}/${tab.id}`,
          method: 'GET',
          json: true,
        }, (_err) => {
          if (_err) {
            _reject(_err);
          } else {
            log(`tab ${tab.id} (${tab.url}) closed`);
            _resolve(true);
          }
        });
      });
    }

    return new Promise((resolve, reject) => {
      let blank = 0;

      request({
        uri: `http://${this.options.broker.host}/tabs/${this.options.id}`,
        method: 'GET',
        json: true,
      }, (err, response, tabs) => {
        if (err) {
          reject(err);
        } else {
          const closeTabCalls = [];

          if (tabs.length > 0) {
            for (const tab of tabs) {
              if (/about:blank/.test(tab.url)) {
                blank++;
              } else if (!/about:blank/.test(tab.url) || blank > 0) {
                closeTabCalls.push(rp(tab));
              }
            }
          }

          Promise.all(closeTabCalls).then(resolve, reject);
        }
      });
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

  report(error = null) {
    return new Promise((resolve, reject) => {
      log('taking screenshot');

      this.screenshot().then((img) => {
        const imgName = Math.ceil(Math.random() * Date.now());
        const img64 = this.options.driver === automator.DRIVER_CHROMELESS ? img.value : `data:image/png;base64,${img.value}`;
        const imgPath = base64img.imgSync(img64, '/tmp', `${imgName}`);

        log('looking for report methods');

        switch (this.options.reportMethod) {
          case 'slack':
            log('sending report via slack');

            slackReporter({
              filePath: imgPath,
              description: error ? JSON.stringify(error) : '_Automation has failed_',
              details: this.options.persona,
            }, {
              slack: this.options.slack,
              aws: this.options.aws,
            }).then(resolve)
                .catch((err) => {
                  elog('there was a problem reporting to slack');
                  elog(err);
                  return reject(err);
                });
            break;
          default:
            resolve();
            break;
        }
      }).catch((err) => {
        elog('there was a problem reporting the error');
        elog(err);
        return reject(err);
      });
    });
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
              log(`[${path.name}] step "${nextStep.name}" finished`);

              stepsData.steps[nextStep.name] = data;

              resolve();
            }, (err) => {
              elog(`[${path.name}] step "${nextStep.name}" failed`);

              reject(err);
            });
          });
        }).then(() => {
          log('all steps were succesful');

          resolveFinal(stepsData);
        }, (err) => {
          elog('one or more steps failed');
          try {
            if (self.options.autoReport) {
              log('auto report is enabled');
              self.report(err).bind(err)
                .then(rejectFinal)
                .catch(rejectFinal);
            } else {
              log('auto report is not enabled: ' + JSON.stringify(self.options));
            }
          } catch (_err) {
            elog(_err);
            self.report(_err).bind(_err)
              .then(rejectFinal)
              .catch(rejectFinal);
          }
          rejectFinal(err);
        });
      }

      log(`running step "${step.name}"`);

      return Promise.promisify(step.run, {
        multiArgs: false,
      }).call(self).then((data) => {
        stepsData.steps[step.name] = data;

        resolveFinal(stepsData);
      }, (err) => {
        if (self.options.autoReport) {
          self.report(err).bind(err)
            .then(rejectFinal)
            .catch(rejectFinal);
        }
        rejectFinal(err);
      });
    });
  }
};
