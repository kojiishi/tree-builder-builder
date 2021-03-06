var ParseExperiment = require('../lib/parse-experiment');

var stageLoader = require('./stage-loader');
var fancyStages = require('./fancy-stages');
var stages = require('./stages');
var device = require('./device');
var types = require('./types');

// Returns a list of {stages: [pipeline-element], output: result}
function appendEdges(experiment, stages, edges) {
  var newList = [];
  for (var j = 0; j < edges.length; j++) {
    var newStages = stages.concat(edges[j].stages);
    if (edges[j].output in experiment.tree) {
      if (edges[j].output.substring(edges[j].output.length - 1) !== '*'){
        newStages.push('output:' + edges[j].output);
      }
      newList = newList.concat(appendEdges(experiment, newStages, experiment.tree[edges[j].output]));
    } else {
      newList.push({stages: newStages, output: edges[j].output});
    }
  }
  return newList;
}

function experimentTask(name, experiment) {
  gulp.task(name, function(cb) { runExperiment(experiment, cb); });
}

var multiplexingStages = ['tracePIDSplitter', 'traceTreeSplitter'];

function stageFor(stageName, options, inputSpec) {
  // override output definition to deal with output name generation
  if (stageName.substring(0, 7) == 'output:') {
    return stageLoader.stage([
      fancyStages.tee(),
      fancyStages.right(fancyStages.keyMap(fancyStages.outputName(inputSpec, stageName.substring(7)))),
      fancyStages.right(fancyStages.mapToTuples()),
      fancyStages.right(fancyStages.map(stages.toFile())),
      fancyStages.justLeft()
    ]);
  }

  // TODO: convert ejs to option processing, roll this in with multiplexingStages
  if (stageName == 'ejs') {
    return stageLoader.stage([
      fancyStages.valueMap(stageLoader.stageSpecificationToStage('ejs:')),
      fancyStages.deMap()
    ]);
  }

  if (multiplexingStages.indexOf(stageName) > -1) {
    return stageLoader.stage([
      fancyStages.valueMap(stageLoader.stageSpecificationToStage(stageName, options)),
      fancyStages.deMap()
    ])
  }

  return fancyStages.valueMap(stageLoader.stageSpecificationToStage(stageName, options));
}

function updateOptions(optionsDict) {
  for (key in optionsDict) {
    if (key in options) {
      console.warn('Overriding option ' + key + ' from commandline value ' + options[key] + ' to ' + optionsDict[key]);
    }
    options[key] = optionsDict[key];
  }
  if (optionsDict.chromium)
    device.init(options);
}

var options = undefined;
function init(parsedOptions) {
  options = parsedOptions;
}

function outputFor(input, output) {
  if (output == 'console') {
    return [stages.taggedConsoleOutput()];
  } else {
    return [
      fancyStages.keyMap(fancyStages.outputName(input, output)),
      fancyStages.mapToTuples(),
      fancyStages.map(stages.toFile())
    ];
  }
}

// exposed so this can be overridden in testing
module.exports.outputFor = outputFor;

function runExperiment(experiment, incb) {
  updateOptions(experiment.flags);
  var pipelines = [];
  for (var i = 0; i < experiment.inputs.length; i++) {
    var edges = experiment.tree[experiment.inputs[i]];
    var stagesList = [];
    stagesList = appendEdges(experiment, stagesList, edges);

    for (var j = 0; j < stagesList.length; j++) {
      if (experiment.inputs[i].substring(0, 7) == 'http://') {
	var input = experiment.inputs[i];
	var inputStages = [
          fancyStages.immediate(input),
          fancyStages.listify(),
          fancyStages.asKeys(),
          fancyStages.valueMap(device.telemetrySave())];
      } else if (experiment.inputs[i].substring(0, 8) == '!http://') {
	var input = experiment.inputs[i].slice(1);
        var inputStages = [
          fancyStages.immediate(input),
          fancyStages.listify(),
          fancyStages.asKeys(),
          fancyStages.valueMap(device.telemetrySaveNoStyle())];
      } else {
	if (experiment.inputs[i][0] == '!') {
	  var fileToJSON = stageFor("fileToString");
	  var input = experiment.inputs[i].slice(1);
	} else {
	  var fileToJSON = stageFor("fileToJSON");
	  var input = experiment.inputs[i];
	}
	var inputStages = [fancyStages.fileInputs(input), fancyStages.asKeys(), fileToJSON];
      }
      var pl = inputStages.concat(
          stagesList[j].stages.map(function(a) { return stageFor(a, experiment.options[a], input); }));
      pl = pl.concat(module.exports.outputFor(input, stagesList[j].output));
      pipelines.push(pl);
    }
  }
  var cb = function() { incb(); }
  for (var i = 0; i < pipelines.length; i++) {
    var cb = (function(i, cb) {
      return function() {
        stageLoader.processStages(pipelines[i], cb, function(e) {
          console.log('failed pipeline', e, '\n', e.stack); cb(null);
        });
      }
    })(i, cb);
  }
  cb(null);
}

function experimentPhase() {
  return {
    impl: runExperiment,
    name: 'experimentPhase',
    input: types.experiment,
    output: types.unit
  };
}

function parseExperiment() {
  return {
    impl: function(data, cb) { cb(new ParseExperiment().parse(data)); },
    name: 'parseExperiment',
    input: types.string,
    output: types.experiment
  };
}

module.exports.init = init;
module.exports.experimentPhase = experimentPhase;
module.exports.parseExperiment = parseExperiment;
