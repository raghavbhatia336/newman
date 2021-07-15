var _ = require('lodash');
const runtime = require('postman-runtime'),
    util = require('./util'),
    sdk = require('postman-collection'),
    RunSummary = require('../run/summary'),
    EventEmitter = require('eventemitter3'),
    asyncEach = require('async/each'),
    exportFile = require('../run/export-file');

    /**
     * This object describes the various events raised by Newman, and what each event argument contains.
     * Error and cursor are present in all events.
     *
     * @type {Object}
     */
    runtimeEvents = {
        start: [],
        beforeIteration: [],
        beforeItem: ['item'],
        beforePrerequest: ['events', 'item'],
        prerequest: ['executions', 'item'],
        beforeRequest: ['request', 'item'],
        request: ['response', 'request', 'item', 'cookies', 'history'],
        beforeTest: ['events', 'item'],
        test: ['executions', 'item'],
        item: ['item'],
        iteration: [],
        beforeScript: ['script', 'event', 'item'],
        script: ['execution', 'script', 'event', 'item']
    },

    /**
     * load all the default reporters here. if you have new reporter, add it to this list
     * we know someone, who does not like dynamic requires
     *
     * @type {Object}
     */
    //todo: change cli output to single request 
    defaultReporters = {
        cli: require('../reporters/cli'),
        json: require('../reporters/json'),
        junit: require('../reporters/junit'),
        progress: require('../reporters/progress'),
        emojitrain: require('../reporters/emojitrain')
    };

module.exports = function (options, callback) {
    const runner = new runtime.Runner(),
        emitter = new EventEmitter();

    util.convertCurltoCollection(options.curl, function (err, result) {
        if (err) {
            callback(err); // eslint-disable-line
        }
        options.curl = result;
    });

    //ensuring curl is present before starting the run 
    if (!_.isObject(options.curl) && !sdk.Collection.isCollection(options.curl)) {
        return callback(new Error('expecting valid curl-like options'));
    }

    // store summary object and other relevant information inside the emitter
    emitter.summary = new RunSummary(emitter, options);

    runner.run(options.curl, {}, function (err, run) {
        if (err) { return callback(err); }

        var callbacks = {},
            reporters = _.isString(options.reporters) ? [options.reporters] : options.reporters,
            legacyAssertionIndices = {};

        // emit events for all the callbacks triggered by the runtime
            _.forEach(runtimeEvents, function (definition, eventName) {
                // intercept each runtime.* callback and expose a global object based event
                callbacks[eventName] = function (err, cursor) {
                    var args = arguments,
                        obj = { cursor };

                    // convert the arguments into an object by taking the key name reference from the definition
                    // object
                    _.forEach(definition, function (key, index) {
                        obj[key] = args[index + 2]; // first two are err, cursor
                    });

                    args = [eventName, err, obj];
                    emitter.emit.apply(emitter, args); // eslint-disable-line prefer-spread
                };
            });

            // add non generic callback handling
            _.assignIn(callbacks, {

                /**
                 * Bubbles up console messages.
                 *
                 * @param {Object} cursor - The run cursor instance.
                 * @param {String} level - The level of console logging [error, silent, etc].
                 * @returns {*}
                 */
                console (cursor, level) {
                    emitter.emit('console', null, {
                        cursor: cursor,
                        level: level,
                        messages: _.slice(arguments, 2)
                    });
                },

                /**
                 * The exception handler for the current run instance.
                 *
                 * @todo Fix bug of arg order in runtime.
                 * @param {Object} cursor - The run cursor.
                 * @param {?Error} err - An Error instance / null object.
                 * @returns {*}
                 */
                exception (cursor, err) {
                    emitter.emit('exception', null, {
                        cursor: cursor,
                        error: err
                    });
                },

                assertion (cursor, assertions) {
                    _.forEach(assertions, function (assertion) {
                        var errorName = _.get(assertion, 'error.name', 'AssertionError');

                        !assertion && (assertion = {});

                        // store the legacy assertion index
                        assertion.index && (legacyAssertionIndices[cursor.ref] = assertion.index);

                        emitter.emit('assertion', (assertion.passed ? null : {
                            name: errorName,
                            index: assertion.index,
                            test: assertion.name,
                            message: _.get(assertion, 'error.message', assertion.name || ''),

                            stack: errorName + ': ' + _.get(assertion, 'error.message', '') + '\n' +
                                '   at Object.eval sandbox-script.js:' + (assertion.index + 1) + ':' +
                                ((cursor && cursor.position || 0) + 1) + ')'
                        }), {
                            cursor: cursor,
                            assertion: assertion.name,
                            skipped: assertion.skipped,
                            error: assertion.error,
                            item: run.resolveCursor(cursor)
                        });
                    });
                },

                /**
                 * Custom callback to override the `done` event to fire the end callback.
                 *
                 * @todo Do some memory cleanup here?
                 * @param {?Error} err - An error instance / null passed from the done event handler.
                 * @param {Object} cursor - The run instance cursor.
                 * @returns {*}
                 */
                done (err, cursor) {
                    // in case runtime faced an error during run, we do not process any other event and emit `done`.
                    // we do it this way since, an error in `done` callback would have anyway skipped any intermediate
                    // events or callbacks
                    if (err) {
                        emitter.emit('done', err, emitter.summary);
                        callback(err, emitter.summary);

                        return;
                    }

                    // we emit a `beforeDone` event so that reporters and other such addons can do computation before
                    // the run is marked as done
                    emitter.emit('beforeDone', null, {
                        cursor: cursor,
                        summary: emitter.summary
                    });


                    asyncEach(emitter.exports, exportFile, function (err) {
                        // we now trigger actual done event which we had overridden
                        emitter.emit('done', err, emitter.summary);
                        callback(err, emitter.summary);
                    });
                }
            });
            
            // initialise all the reporters
            !emitter.reporters && (emitter.reporters = {});
            _.isArray(reporters) && _.forEach(reporters, function (reporterName) {
                // disallow duplicate reporter initialisation
                if (_.has(emitter.reporters, reporterName)) { return; }

                var Reporter;

                try {
                    // check if the reporter is an external reporter
                    Reporter = require((function (name) { // ensure scoped packages are loaded
                        var prefix = '',
                            scope = (name.charAt(0) === '@') && name.substr(0, name.indexOf('/') + 1);

                        if (scope) {
                            prefix = scope;
                            name = name.substr(scope.length);
                        }

                        return prefix + 'newman-reporter-' + name;
                    }(reporterName)));
                }
                // @todo - maybe have a debug mode and log error there
                catch (error) {
                    if (!defaultReporters[reporterName]) {
                        // @todo: route this via print module to respect silent flags
                        console.warn(`newman: could not find "${reporterName}" reporter`);
                        console.warn('  ensure that the reporter is installed in the same directory as newman');

                        // print install instruction in case a known reporter is missing
                        if (knownReporterErrorMessages[reporterName]) {
                            console.warn(knownReporterErrorMessages[reporterName]);
                        }
                        else {
                            console.warn('  please install reporter using npm\n');
                        }
                    }
                }

                // load local reporter if its not an external reporter
                !Reporter && (Reporter = defaultReporters[reporterName]);

                try {
                    // we could have checked _.isFunction(Reporter), here, but we do not do that so that the nature of
                    // reporter error can be bubbled up
                    Reporter && (emitter.reporters[reporterName] = new Reporter(emitter,
                        _.get(options, ['reporter', reporterName], {}), options));
                }
                catch (error) {
                    // if the reporter errored out during initialisation, we should not stop the run simply log
                    // the error stack trace for debugging
                    console.warn(`newman: could not load "${reporterName}" reporter`);

                    if (!defaultReporters[reporterName]) {
                        // @todo: route this via print module to respect silent flags
                        console.warn(`  this seems to be a problem in the "${reporterName}" reporter.\n`);
                    }
                    console.warn(error);
                }
            });
            // raise warning when more than one dominant reporters are used
            (function (reporters) {
                // find all reporters whose `dominant` key is set to true
                var conflicts = _.keys(_.transform(reporters, function (conflicts, reporter, name) {
                    reporter.dominant && (conflicts[name] = true);
                }));

                (conflicts.length > 1) && // if more than one dominant, raise a warning
                    console.warn(`newman: ${conflicts.join(', ')} reporters might not work well together.`);
            }(emitter.reporters));

            // we ensure that everything is async to comply with event paradigm and start the run
            setImmediate(function () {
                run.start(callbacks);
            });
    });
};

