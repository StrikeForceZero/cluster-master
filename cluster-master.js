// Set up a cluster and set up resizing and such.

var cluster = require("cluster")
, _ = require("underscore")
, quitting = false
, restarting = false
, tooQuick = false
, path = require("path")
, clusterSize = 0
, env
, os = require("os")
, onmessage
, repl = require('repl')
, replAddressPath = process.env.CLUSTER_MASTER_REPL || 'cluster-master-socket'
, net = require('net')
, fs = require('fs')
, util = require('util')
, minRestartAge = 10000
, maxUnstableRestarts = 5
, unstableRestarts = 0
, listeningWorkers = true
, danger = false
, cleanCondemnedWorkersInterval = 60000
, tooQuickTimeOut = 30000
, forcefullyKillTimeOut = 5000
, logger;

exports = module.exports = clusterMaster
exports.restart = restart
exports.disconnectWorker = disconnectWorker
exports.handleCleaningOfCondemnedWorkers = handleCleaningOfCondemnedWorkers;
exports.resize = resize
exports.quitHard = quitHard
exports.quit = quit

var debugStreams = {}
function debug () {
  if (logger) {
    logger.debug.apply(logger, arguments);
  } else {
    console.error.apply(console, arguments)
  }

  var msg = util.format.apply(util, arguments)
  Object.keys(debugStreams).forEach(function (s) {
    try {
      // if the write fails, just remove it.
      debugStreams[s].write(msg + '\n')
      if (debugStreams[s].repl) debugStreams[s].repl.displayPrompt()
    } catch (e) {
      delete debugStreams[s]
    }
  })
}

function clusterMaster (config) {
  if (typeof config === "string") config = { exec: config }

  if (config.logger) logger = config.logger;

  if (config.cleanComdemnedWorkersInterval) {
    // zero is not allowed.
    cleanCondemnedWorkersInterval = config.cleanComdemnedWorkersInterval;
  }

  if (!config.exec) {
    throw new Error("Must define a 'exec' script")
  }

  if (!cluster.isMaster) {
    throw new Error("ClusterMaster answers to no one!\n"+
                    "(don't run in a cluster worker script)")
  }

  if (cluster._clusterMaster) {
    throw new Error("This cluster has a master already")
  }

  cluster._clusterMaster = module.exports

  if (typeof config.repl !== 'undefined') replAddressPath = config.repl  // allow null and false

  onmessage = config.onMessage || config.onmessage

  clusterSize = config.size || os.cpus().length

  minRestartAge = config.minRestartAge || minRestartAge

  if (config.listeningWorkers !== undefined) {
    listeningWorkers = config.listeningWorkers;
  }

  if (config.maxUnstableRestarts) maxUnstableRestarts = config.maxUnstableRestarts;

  maxUnstableRestarts = maxUnstableRestarts * clusterSize;

  env = config.env

  var masterConf = { exec: path.resolve(config.exec) }
  if (config.silent) masterConf.silent = true
  if (config.env) masterConf.env = config.env
  if (config.args) masterConf.args = config.args

  cluster.setupMaster(masterConf)

  if (config.signals !== false) {
    // sighup/sigint listeners
    setupSignals()
  }

  forkListener()

  // now make it the right size
  debug((replAddressPath) ? 'resize and then setup repl' : 'resize')
  resize(setupRepl)

  // start worker killer handler
  setInterval(function() {
    handleCleaningOfCondemnedWorkers(cluster.workers);
  }, cleanCondemnedWorkersInterval);
}

function select (field) {
  return Object.keys(cluster.workers).map(function (k) {
    return [k, cluster.workers[k][field]]
  }).reduce(function (set, kv) {
    set[kv[0]] = kv[1]
    return set
  }, {})
}

function setupRepl () {
  if (!replAddressPath) return  // was disabled

  debug('setup repl')
  var socket = null
  var socketAddress = undefined
  if (typeof replAddressPath === 'string') {
    socket = path.resolve(replAddressPath)
  } else if (typeof replAddressPath === 'number') {
    socket = replAddressPath
    if (!isNaN(socket)) socket = +socket
  } else if (replAddressPath.address && replAddressPath.port) {
    socket = replAddressPath.port
    socketAddress = replAddressPath.address
  }
  var connections = 0

  if (typeof socket === 'string') {
    fs.unlink(socket, function (er) {
      if (er && er.code !== 'ENOENT') throw er
      startRepl()
    })
  } else {
    startRepl()
  }

  function startRepl () {
    debug('starting repl on '+socket+'=')
    process.on('exit', function() {
      try { fs.unlinkSync(socket) } catch (er) {}
    })
    var sockId = 0
    var replServer = net.createServer(function (sock) {
      connections ++
      replEnded = false

      sock.id = sockId ++
      debugStreams['repl-' + sockId] = sock

      sock.write('Starting repl #' + sock.id)
      var r = repl.start({
        prompt: 'ClusterMaster (`help` for cmds) ' + process.pid + ' ' + sock.id + '> ',
        input: sock,
        output: sock,
        terminal: true,
        useGlobal: false,
        ignoreUndefined: true
      })

      var helpCommands = [
        'help        - display these commands',
        'repl        - access the REPL',
        'resize(n)   - resize the cluster to `n` workers',
        'restart(cb) - gracefully restart workers, cb is optional',
        'stop()      - gracefully stop workers and master',
        'kill()      - forcefully kill workers and master',
        'cluster     - node.js cluster module',
        'size        - current cluster size',
        'connections - number of REPL connections to master',
        'workers     - current workers',
        'select(fld) - map of id to field (from workers)',
        'pids        - map of id to pids',
        'ages        - map of id to worker ages',
        'states      - map of id to worker states',
        'debug(a1)   - output `a1` to stdout and all REPLs',
        'sock        - this REPL socket',
        '.exit       - close this connection to the REPL'
      ]

      var context = {
        help: helpCommands,
        repl: r,
        resize: resize,
        restart: restart,
        stop: quit,
        kill: quitHard,
        cluster: cluster,
        get size () {
          return clusterSize
        },
        get connections () {
          return connections
        },
        get workers () {
          var p = select('pid')
          var s = select('state')
          var a = select('age')
          return Object.keys(cluster.workers).map(function (k) {
            return new Worker({ id: k, pid: p[k], state: s[k], age: a[k] })
          })
        },
        select: select,
        get pids () {
          return select('pid')
        },
        get ages () {
          return select('age')
        },
        get states () {
          return select('state')
        },
        // like 'wall'
        debug: debug,
        sock: sock
      }
      var desc = Object.getOwnPropertyNames(context).map(function (n) {
        return [n, Object.getOwnPropertyDescriptor(context, n)]
      }).reduce(function (set, kv) {
        set[kv[0]] = kv[1]
        return set
      }, {})
      Object.defineProperties(r.context, desc)

      sock.repl = r

      r.on('end', function () {
        connections --
        replEnded = true
        if (!ended) sock.end()
      })

      sock.on('end', end)
      sock.on('close', end)
      sock.on('error', end)

      ended = false
      function end () {
        if (ended) return
        ended = true
        if (!replEnded) r.rli.close()
        delete debugStreams['repl-' + sockId]
      }

    })

    if (socketAddress) {
      replServer.listen(socket, socketAddress, function () {
        debug('ClusterMaster repl listening on '+socketAddress+':'+socket)
      })
    } else {
      replServer.listen(socket,  function () {
        debug('ClusterMaster repl listening on '+socket)
      })
    }
  }
}

function Worker (d) {
  this.id = d.id
  this.pid = d.pid
  this.state = d.state
  this.age = d.age
}

Worker.prototype.disconnect = function () {
  cluster.workers[this.id].disconnect()
}

Worker.prototype.kill = function () {
  process.kill(this.pid)
}

function endOfUnstableRestarts() {
  if (Object.keys(cluster.workers).length === clusterSize && !resizing) {
    var stillUnstable = false;
    for (var id in cluster.workers) {
      if (cluster.workers[id].age < 20000) {
        stillUnstable = true;
      }
    }

    if (!stillUnstable) {
      debug("end of the unstable restarts");
      unstableRestarts = 0;
    }
    else {
      setTimeout(endOfUnstableRestarts, 10000);
    }
  }
}

function forkListener () {
  cluster.on("fork", function (worker) {
    worker.birth = Date.now()
    Object.defineProperty(worker, 'age', { get: function () {
      return Date.now() - this.birth
    }, enumerable: true, configurable: true })
    worker.pid = worker.process.pid
    var id = worker.id
    debug("Worker %j setting up", id)
    if (onmessage) worker.on("message", onmessage)
    var disconnectTimer

    worker.on("exit", function () {
      clearTimeout(disconnectTimer)

      if (!worker.suicide) {
        debug("Worker %j exited abnormally", id)
        if (unstableRestarts === maxUnstableRestarts) {
          debug("too many unstable restarts. Stopped.")
          process.exit(1);
          return;
        }
        // don't respawn right away if it's a very fast failure.
        // otherwise server crashes are hard to detect from monitors.
        if (worker.age < minRestartAge) {
          unstableRestarts++;
          setTimeout(endOfUnstableRestarts, 60000);
          debug("Worker %j died too quickly, danger", id)
          danger = true
          // still try again in a few seconds, though.
          resizing = false
          setTimeout(resize, 2000)
          return
        }
      } else {
        debug("Worker %j exited", id)
      }

      if (Object.keys(cluster.workers).length < clusterSize && !resizing) {
        resize()
      }
    })

    worker.on("disconnect", function () {
      debug("Worker %j disconnect", id)
      // give it 1 second to shut down gracefully, or kill
      disconnectTimer = setTimeout(function () {
        debug("Worker %j, forcefully killing", id)
        worker.process.kill("SIGKILL")
      }, forcefullyKillTimeOut)
    })
  })
}

function shouldWorkerBeCondemned(worker) {
  return worker.suicide || !worker.process.connected;
}

function condemnedWorker(worker) {
  if (!worker.condemnationDate) {
    debug("Worker %j, condemned to death", worker.id);
    worker.condemnationDate = Date.now();
  }
}

function shouldWorkerBeKill(worker) {
  return worker.condemnationDate
    && Date.now() - worker.condemnationDate > forcefullyKillTimeOut;
}

function killWorker(worker) {
  debug("Worker %j, roughly killing", worker.id);
  process.kill(worker.process.pid, "SIGKILL");
}

function disconnectWorker(worker) {
  condemnedWorker(worker);
  if (!worker.suicide) {
    debug("Worker %j, disconnecting", worker.id);
    worker.disconnect();
  }
}

function handleCleaningOfCondemnedWorkers(workers) {
  if (restarting) {
    return;
  }

  Object.keys(workers).forEach(function(id) {
    var worker = workers[id];

    if (shouldWorkerBeKill(worker)) {
      killWorker(worker);
    } else if (shouldWorkerBeCondemned(worker)) {
      // It will be roughly kill the next time this method is call.
      condemnedWorker(worker);
    }
  });
}

function restart (cb) {

  if (restarting || tooQuick) {
    debug("Already restarting or too quick restart.  Cannot restart yet.")
    return
  }

  // cleanUp before restarting
  handleCleaningOfCondemnedWorkers(cluster.workers);

  restarting = true
  // prevent too quick reload (30s)
  tooQuick = true
  setTimeout(function() {
    tooQuick = false
  }, tooQuickTimeOut)

  // graceful restart.
  // all the existing workers get killed, and this
  // causes new ones to be spawned.  If there aren't
  // already the intended number, then fork new extras.
  // Apply restart only on worker that are not tagged with willBeDead
  // this will prevent the growth in size when restart is fired
  var current = _.filter(Object.keys(cluster.workers), function(workerId){
    return !(cluster.workers[workerId].willBeDead)
  });

  var length = current.length
  , reqs = clusterSize - length

  var i = 0

  // if we're resizing, then just kill off a few.
  if (reqs !== 0) {
    debug('resize %d -> %d, change = %d',
                  current.length, clusterSize, reqs)

    return resize(clusterSize, function () {
      debug('resize cb')
      length = clusterSize
      graceful()
    })
  }

  // all the current workers, kill and then wait for a
  // new one to spawn before moving on.
  graceful()
  function graceful () {
    debug("graceful %d of %d", i, length)
    if (i >= current.length) {
      debug("graceful completion")
      restarting = false
      return cb && cb()
    }

    var first = (i === 0)
    , id = current[i++]
    , worker = cluster.workers[id]

    if (quitting) {
      if (worker && worker.process.connected) {
        disconnectWorker(worker)
      }
      return graceful()
    }

    // start a new one. if it lives for 2 seconds, kill the worker.
    if (first) {
      function skepticRestart(newbie) {
        var timer = setTimeout(function () {
          newbie.removeListener('exit', skeptic)
          if (worker && worker.process.connected) {
            disconnectWorker(worker)
          }
          graceful()
        }, 2000)
        newbie.on('exit', skeptic)
        function skeptic () {
          debug('New worker died quickly. Aborting restart.')
          restarting = false
          clearTimeout(timer)
        }
      }

      if (listeningWorkers){
        cluster.once('listening', skepticRestart);
      }
      else {
        cluster.once('fork', skepticRestart);
      }
    } else {
      function classicRestart(newbie) {
        if (worker && worker.process.connected) {
          disconnectWorker(worker)
        }
      }

      if (listeningWorkers){
        cluster.once('listening', classicRestart);
      }
      else {
        cluster.once('fork', classicRestart);
      }
      graceful()
    }

    cluster.fork(env)
  }
}



var resizing = false
var resizeCbs = []
function resize (n, cb_) {
  if (typeof n === 'function') cb_ = n, n = clusterSize

  if (cb_)
    resizeCbs.push(cb_)

  if (resizing) {
    debug("Already resizing.  Cannot resize yet.");
    return
  }

  resizing = true;
  function cb() {
    debug('done resizing')

    resizing = false
    var q = resizeCbs.slice(0)
    resizeCbs.length = 0
    q.forEach(function(c) {
      c()
    })
    if (clusterSize !== Object.keys(cluster.workers).length) {
      if (danger && clusterSize === 0) {
        debug('DANGER! something bad has happened')
        process.exit(1)
      } else {
        danger = true
        debug('DANGER! wrong number of workers')
        setTimeout(resize, 1000)
      }
    } else {
      danger = false
    }
  }

  if (n >= 0) clusterSize = n
  var current = Object.keys(cluster.workers)
  , c = current.length
  , req = clusterSize - c

  // avoid angry "listening" listeners
  cluster.setMaxListeners(clusterSize * 2)

  if (c === clusterSize) {
    resizing = false
    return cb()
  }

  var thenCnt = 0
  function then () {
    thenCnt ++
    return then2
  }
  function then2 () {
    if (--thenCnt === 0) {
      resizing = false
      return cb()
    }
  }

  // make us have the right number of them.
  if (req > 0) while (req -- > 0) {
    debug('resizing up', req)
    if (listeningWorkers) {
      cluster.once('listening', then())
    }
    else {
      cluster.once('fork', then())
    }

    cluster.fork(env)
  } else for (var i = clusterSize; i < c; i ++) {
    var worker = cluster.workers[current[i]]
    debug('resizing down', current[i])
    worker.once('exit', then())
    if (worker && worker.process.connected) {
      disconnectWorker(worker)
    }
  }
}



function quitHard () {
  quitting = true
  quit()
}



function quit () {
  if (quitting) {
    debug("Forceful shutdown")
    // last ditch effort to force-kill all workers.
    Object.keys(cluster.workers).forEach(function (id) {
      var w = cluster.workers[id]
      if (w && w.process) w.process.kill("SIGKILL")
    })
    process.exit(1)
  }

  debug("Graceful shutdown...")
  clusterSize = 0
  quitting = true
  restart(function () {
    debug("Graceful shutdown successful")
    process.exit(0)
  })
}


function setupSignals () {
  try {
    process.on("SIGHUP", restart)
    process.on("SIGINT", quit)
  } catch (e) {
    // Must be on Windows, waaa-waaah.
  }

  process.on("exit", function () {
    if (!quitting) quitHard()
  })
}
