import { resolveDoctorScript, DOCTOR_MAX_OUTPUT_CHARS } from '../../src/services/doctor';
import { listQuickActions, runQuickAction } from '../../src/services/quick-actions';

describe('doctor service', () => {
  test('should resolve the bundled script', () => {
    const p = resolveDoctorScript();
    expect(p).toBeTruthy();
    expect(p!).toMatch(/alfred-doctor\.sh$/);
  });

  test('should cap output constant sanely', () => {
    expect(DOCTOR_MAX_OUTPUT_CHARS).toBeGreaterThanOrEqual(4000);
  });
});

describe('quick actions registry', () => {
  test('should list doctor first', () => {
    const actions = listQuickActions();
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0].id).toBe('doctor');
    expect(actions[0].label).toBeTruthy();
  });

  test('should reject unknown actions without running anything', async () => {
    const r = await runQuickAction('nope');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Unknown quick action/);
  });
});
