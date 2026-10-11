const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const markerPath = process.env.E2E_FIRST_LOOP_MARKER;
const reportPath = process.env.E2E_STARTUP_WATCHDOG_REPORT ??
  path.join(process.env.RUNNER_TEMP ?? process.cwd(), `bridge-in-startup-watchdog-${process.env.GITHUB_RUN_ID ?? 'local'}.json`);
const workflowCreatedAt = process.env.E2E_WORKFLOW_CREATED_AT;
const workflowCreatedAtMs = Date.parse(workflowCreatedAt ?? '');
const jobStartedAt = Date.parse(process.env.E2E_ANDROID_JOB_STARTED_AT ?? '');
const deadlineMs = Number(process.env.E2E_ANDROID_STARTUP_DEADLINE_MS ?? 300_000);
const deadlineAt = workflowCreatedAtMs + deadlineMs;
const args = process.argv.slice(2);
const checkPhase = args[0] === '--check-startup-deadline' ? args[1] : undefined;

if ((!checkPhase && !markerPath) || !reportPath || !Number.isFinite(workflowCreatedAtMs) || !Number.isFinite(jobStartedAt) ||
    !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
  throw new Error('Startup watchdog requires marker/report paths, workflow/job timestamps, and a positive deadline.');
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, reportPath);
}

function startupMetrics(firstLoopAt) {
  const dispatchToFirstLoopMs = Number.isFinite(firstLoopAt) ? firstLoopAt - workflowCreatedAtMs : undefined;
  const jobToFirstLoopMs = Number.isFinite(firstLoopAt) ? firstLoopAt - jobStartedAt : undefined;
  return {
    workflowCreatedAt: new Date(workflowCreatedAtMs).toISOString(),
    androidJobStartedAt: new Date(jobStartedAt).toISOString(),
    ...(Number.isFinite(firstLoopAt) ? { firstLoopStartedAt: new Date(firstLoopAt).toISOString() } : {}),
    ...(dispatchToFirstLoopMs !== undefined ? { dispatchToFirstLoopMs } : {}),
    ...(jobToFirstLoopMs !== undefined ? { jobToFirstLoopMs } : {}),
    firstLoopMarkerMeaning: 'loop_started event is written before the first deposit UI action',
    withinFiveMinuteTarget: Number.isFinite(dispatchToFirstLoopMs) && dispatchToFirstLoopMs <= deadlineMs
  };
}

function stopProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

if (checkPhase) {
  if (Date.now() >= deadlineAt) {
    const observedAt = Date.now();
    writeReport({
      status: 'startup_deadline_exceeded_during_setup',
      ...startupMetrics(Number.NaN),
      phase: checkPhase,
      deadlineAt: new Date(deadlineAt).toISOString(),
      observedAt: new Date(observedAt).toISOString(),
      dispatchToObservedMs: observedAt - workflowCreatedAtMs,
      firstLoopStarted: false,
      deadlineMs
    });
    console.error(`::error::The five-minute first-loop budget expired during ${checkPhase}.`);
    process.exitCode = 1;
  } else {
    console.log(`Startup budget remaining after ${checkPhase}: ${deadlineAt - Date.now()}ms.`);
  }
} else {
function main() {
  const now = Date.now();
  if (now >= deadlineAt) {
    writeReport({
      status: 'startup_deadline_exceeded_before_playwright',
      ...startupMetrics(Number.NaN),
      deadlineAt: new Date(deadlineAt).toISOString(),
      observedAt: new Date(now).toISOString(),
      dispatchToObservedMs: now - workflowCreatedAtMs,
      firstLoopStarted: false,
      deadlineMs
    });
    console.error(`::error::The workflow reached Playwright after its ${deadlineMs}ms first-loop deadline.`);
    process.exitCode = 1;
    return;
  }

  const child = spawn('yarn', ['playwright', 'test', ...args], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: 'inherit'
  });
  let firstLoop;
  let exceededDeadline = false;
  let graceTimer;
  let terminationSignal;

  function terminateGroupAfterGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      if (processGroupExists(child.pid)) stopProcessGroup(child.pid, 'SIGKILL');
    }, 10_000);
  }

  function expireDeadline(observedAt) {
    if (exceededDeadline) return;
    exceededDeadline = true;
    const firstLoopAt = firstLoop?.at ? Date.parse(firstLoop.at) : Number.NaN;
    writeReport({
      status: 'startup_deadline_exceeded',
      ...startupMetrics(firstLoopAt),
      deadlineAt: new Date(deadlineAt).toISOString(),
      observedAt: new Date(observedAt).toISOString(),
      firstLoopStarted: Boolean(firstLoop),
      deadlineMs
    });
    console.error(`::error::The first bridge-in loop did not start within ${deadlineMs}ms of workflow creation.`);
    stopProcessGroup(child.pid, 'SIGTERM');
    terminateGroupAfterGrace();
  }

  function handleTermination(signal) {
    if (terminationSignal) {
      stopProcessGroup(child.pid, 'SIGKILL');
      return;
    }
    terminationSignal = signal;
    clearInterval(watchdog);
    if (!firstLoop) firstLoop = readMarker();
    const firstLoopAt = firstLoop?.at ? Date.parse(firstLoop.at) : Number.NaN;
    const observedAt = Date.now();
    writeReport({
      status: 'workflow_cancelled_during_playwright',
      ...startupMetrics(firstLoopAt),
      observedAt: new Date(observedAt).toISOString(),
      dispatchToObservedMs: observedAt - workflowCreatedAtMs,
      firstLoopStarted: Boolean(firstLoop),
      cancellationSignal: signal,
      deadlineMs
    });
    stopProcessGroup(child.pid, 'SIGTERM');
    terminateGroupAfterGrace();
  }

  process.on('SIGINT', handleTermination);
  process.on('SIGTERM', handleTermination);

  const watchdog = setInterval(() => {
    if (!firstLoop) firstLoop = readMarker();
    if (firstLoop) {
      const firstLoopAt = firstLoop.at ? Date.parse(firstLoop.at) : Number.NaN;
      if (Number.isFinite(firstLoopAt) && firstLoopAt <= deadlineAt) {
        clearInterval(watchdog);
        return;
      }
      expireDeadline(Date.now());
      return;
    }

    const observedAt = Date.now();
    if (observedAt >= deadlineAt) expireDeadline(observedAt);
  }, 250);

  child.on('error', error => {
    clearInterval(watchdog);
    writeReport({
      status: 'playwright_spawn_failed',
      ...startupMetrics(Number.NaN),
      observedAt: new Date().toISOString(),
      firstLoopStarted: false,
      error: { name: error.name, message: error.message }
    });
    console.error(error);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    clearInterval(watchdog);
    if (!firstLoop) firstLoop = readMarker();

    if (terminationSignal) {
      if (processGroupExists(child.pid)) {
        stopProcessGroup(child.pid, 'SIGTERM');
        if (!graceTimer) terminateGroupAfterGrace();
      } else if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
      return;
    }

    const firstLoopAt = firstLoop?.at ? Date.parse(firstLoop.at) : Number.NaN;
    if (Number.isFinite(firstLoopAt) && firstLoopAt > deadlineAt) {
      exceededDeadline = true;
      if (!graceTimer && processGroupExists(child.pid)) {
        stopProcessGroup(child.pid, 'SIGTERM');
        terminateGroupAfterGrace();
      }
    }
    if (graceTimer && !processGroupExists(child.pid)) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (exceededDeadline) {
      writeReport({
        status: 'startup_deadline_exceeded',
        ...startupMetrics(firstLoopAt),
        deadlineAt: new Date(deadlineAt).toISOString(),
        observedAt: new Date().toISOString(),
        firstLoopStarted: Boolean(firstLoop),
        playwrightExitCode: code,
        playwrightSignal: signal,
        deadlineMs
      });
    } else {
      writeReport({
        status: firstLoop ? 'first_loop_started' : 'exited_before_first_loop',
        ...startupMetrics(firstLoopAt),
        observedAt: new Date().toISOString(),
        firstLoopStarted: Boolean(firstLoop),
        playwrightExitCode: code,
        playwrightSignal: signal
      });
    }

    process.exitCode = exceededDeadline || !firstLoop ? 1 : code ?? 1;
  });
}

main();
}
