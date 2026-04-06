import path from 'path';
import { readJson, writeJson } from '../utils/helper.js';

export class StateStore {
  constructor(baseDir) {
    this.filePath = path.join(baseDir, 'state.json');
  }

  async load() {
    return (await readJson(this.filePath, {
      activeMode: null,
      plan: null,
      lastProductSnapshot: null,
      session: null,
      history: [],
    })) || {
      activeMode: null,
      plan: null,
      lastProductSnapshot: null,
      session: null,
      history: [],
    };
  }

  async save(state) {
    await writeJson(this.filePath, state);
  }

  async patch(partial) {
    const current = await this.load();
    const next = {
      ...current,
      ...partial,
    };
    await this.save(next);
    return next;
  }

  async resetPlan() {
    const current = await this.load();
    current.activeMode = null;
    current.plan = null;
    await this.save(current);
    return current;
  }
}
