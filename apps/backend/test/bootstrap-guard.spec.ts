import { runWithFatalGuard } from '../src/bootstrap-guard';

/**
 * Fatal bootstrap guard (#98 leg 3). `void bootstrap()` used to swallow a startup rejection into an
 * unhandled promise rejection — the process would limp on or die without a clear signal. The guard
 * turns any bootstrap failure into a logged fatal + a non-zero exit.
 */
describe('runWithFatalGuard (#98)', () => {
  it('does not exit or log fatal when bootstrap resolves', async () => {
    const exit = vi.fn();
    const logFatal = vi.fn();
    await runWithFatalGuard(async () => {}, { exit, logFatal });
    expect(exit).not.toHaveBeenCalled();
    expect(logFatal).not.toHaveBeenCalled();
  });

  it('logs a fatal and exits non-zero when bootstrap rejects', async () => {
    const exit = vi.fn();
    const logFatal = vi.fn();
    await runWithFatalGuard(async () => {
      throw new Error('DB unreachable at boot');
    }, { exit, logFatal });
    expect(logFatal).toHaveBeenCalledTimes(1);
    expect(logFatal.mock.calls[0][0]).toMatch(/DB unreachable at boot/);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
