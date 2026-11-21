'use strict';

const { expect } = require('chai');
const { AccessError, findLock, findLockOfCode, codeId, toPinCommand, toAccessAnswer } = require('./lib/access');
const { PinManager } = require('./lib/pinManager');

const LOCKS = [
  { id: '1001', name: 'Front door', pinIds: [1, 2] },
  { id: '1002', name: 'Garden door', pinIds: [2, 3] },
  { id: '1003', name: 'Garage', pinIds: [] },
];

/**
 * @param {() => unknown} fn call that must fail
 * @returns {AccessError} the error
 */
function failure(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).to.be.instanceOf(AccessError);
    return /** @type {AccessError} */ (error);
  }
  throw new Error('no error');
}

/** @returns {{manager: PinManager, requests: {method: string, path: string, data?: any}[]}} a fake bridge */
function fakeManager() {
  const log = { info: () => {}, debug: () => {}, warn: () => {} };
  const manager = new PinManager(/** @type {any} */ ({ log }));
  manager.addLock('1001');
  /** @type {{method: string, path: string, data?: any}[]} */
  const requests = [];
  manager.request = /** @type {any} */ (
    async (/** @type {string} */ method, /** @type {string} */ path, /** @type {any} */ options = {}) => {
      requests.push({ method, path, data: options.data });
      return { data: method === 'post' ? { id: 7 } : { pin: '123456', alias: 'Old', weekdays: 127 } };
    }
  );
  manager.load = /** @type {any} */ (async () => {});
  return { manager, requests };
}

/**
 * Runs a standard command through the real PinManager.
 *
 * @param {PinManager} manager the manager with the fake bridge
 * @param {string} command standard command
 * @param {Record<string, unknown>} msg its message
 * @param {number} [id] code id
 * @returns {Promise<Record<string, any>>} the answer of the catalog
 */
async function run(manager, command, msg, id) {
  const pin = toPinCommand(command, msg, '1001', id);
  return toAccessAnswer(command, await manager.handleCommand(pin.command, /** @type {any} */ (pin.message)), msg);
}

describe('access commands of the shared catalog', () => {
  it('finds the lock by id, by name or the only one', () => {
    expect(findLock('1002', LOCKS)).to.equal('1002');
    expect(findLock('front DOOR', LOCKS)).to.equal('1001');
    expect(findLock('garage', LOCKS)).to.equal('1003');
    expect(findLock(undefined, [LOCKS[0]])).to.equal('1001');
    expect(failure(() => findLock('door', LOCKS)).answer()).to.deep.include({
      reason: 'AMBIGUOUS',
      candidates: ['Front door', 'Garden door'],
    });
    expect(failure(() => findLock('', LOCKS)).reason).to.equal('AMBIGUOUS');
    expect(failure(() => findLock('Cellar', LOCKS)).answer()).to.deep.include({
      reason: 'NOT_FOUND',
      candidates: ['Front door', 'Garden door', 'Garage'],
    });
  });

  it('finds the lock of a code when the message names none', () => {
    expect(findLockOfCode(3, LOCKS)).to.equal('1002');
    expect(findLockOfCode(9, [LOCKS[0]])).to.equal('1001');
    expect(failure(() => findLockOfCode(2, LOCKS)).reason).to.equal('AMBIGUOUS');
    expect(failure(() => findLockOfCode(9, LOCKS)).reason).to.equal('NOT_FOUND');
    expect(codeId('5')).to.equal(5);
    expect(failure(() => codeId(undefined)).reason).to.equal('BAD_REQUEST');
  });

  it('createCode sends the fields of createPin and answers {id, code}', async () => {
    const { manager, requests } = fakeManager();
    const msg = {
      name: 'Craftsman',
      code: '048213',
      start: '2026-11-22T08:00',
      end: '2026-11-22T12:00',
      dayStart: '08:00',
      dayEnd: '12:00',
      weekdays: ['Sun'],
    };
    expect(toPinCommand('createCode', msg, '1001').command).to.equal('createPin');
    expect(await run(manager, 'createCode', msg)).to.deep.equal({ id: 7, code: '048213', lock: '1001' });
    const post = requests.find((r) => r.method === 'post');
    expect(post && post.path).to.equal('/lock/1001/pin');
    expect(post && post.data).to.deep.include({
      pin: '048213',
      alias: 'Craftsman',
      dayStartTime: 8 * 3600,
      dayEndTime: 12 * 3600,
      weekdays: 64,
    });
    expect(post && post.data.endDate - post.data.startDate).to.equal(4 * 3600);
    expect(failure(() => toPinCommand('createCode', { name: 'Craftsman' }, '1001')).reason).to.equal('BAD_REQUEST');
  });

  it('updateCode changes only the given fields', async () => {
    const { manager, requests } = fakeManager();
    expect(toPinCommand('updateCode', { id: 5, name: 'Neighbour' }, '1001', 5)).to.deep.equal({
      command: 'updatePin',
      message: { lockId: '1001', alias: 'Neighbour', pinId: 5 },
    });
    expect(await run(manager, 'updateCode', { id: 5, name: 'Neighbour' }, 5)).to.deep.equal({
      ok: true,
      id: 5,
      lock: '1001',
    });
    const put = requests.find((r) => r.method === 'put');
    expect(put && put.path).to.equal('/lock/1001/pin/5');
    // the code stays
    expect(put && put.data).to.deep.include({ pin: '123456', alias: 'Neighbour' });
  });

  it('deleteCode deletes, getCodes lists without the codes', async () => {
    const { manager, requests } = fakeManager();
    expect(toPinCommand('deleteCode', { id: '5' }, '1001', 5).command).to.equal('deletePin');
    expect(await run(manager, 'deleteCode', { id: '5' }, 5)).to.deep.equal({ ok: true, id: 5, lock: '1001' });
    expect(requests.some((r) => r.method === 'delete' && r.path === '/lock/1001/pin/5')).to.equal(true);

    manager.locks['1001'].pins.set(5, {
      id: 5,
      alias: 'Neighbour',
      startDate: 1795000000,
      endDate: null,
      dayStartTime: null,
      dayEndTime: null,
      weekdays: null,
    });
    const answer = await run(manager, 'getCodes', {});
    expect(answer.lock).to.equal('1001');
    expect(answer.codes).to.have.length(1);
    expect(answer.codes[0]).to.deep.include({
      id: 5,
      name: 'Neighbour',
      start: 1795000000000,
      end: null,
      weekdays: 127,
    });
    expect(answer.codes[0]).to.not.have.property('code');
  });
});
