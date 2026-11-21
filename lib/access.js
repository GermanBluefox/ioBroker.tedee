'use strict';

/**
 * The commands of the shared catalog of ioBroker adapters, family access (HELP.md of ioBroker.assistant), mapped onto
 * the PIN commands of lib/pinManager.js. The PIN commands keep their names, parameters and answers for old scripts.
 */

/** standard command -> PIN command */
const ACCESS_COMMANDS = {
  createCode: 'createPin',
  getCodes: 'getPins',
  updateCode: 'updatePin',
  deleteCode: 'deletePin',
};

/** fields of createCode / updateCode -> fields of createPin / updatePin */
const FIELDS = {
  code: 'pin',
  name: 'alias',
  start: 'startDate',
  end: 'endDate',
  dayStart: 'dayStartTime',
  dayEnd: 'dayEndTime',
  weekdays: 'weekdays',
};

/** An error with the code of the catalog, answered as {error, reason, candidates?} */
class AccessError extends Error {
  /**
   * @param {string} message text for a human
   * @param {string} reason NOT_ALLOWED, NOT_FOUND, AMBIGUOUS, BAD_REQUEST
   * @param {string[]} [candidates] names to choose from
   */
  constructor(message, reason, candidates) {
    super(message);
    this.reason = reason;
    this.candidates = candidates;
  }

  /** @returns {{error: string, reason: string, candidates?: string[]}} the answer */
  answer() {
    return this.candidates
      ? { error: this.message, reason: this.reason, candidates: this.candidates }
      : { error: this.message, reason: this.reason };
  }
}

/**
 * @param {unknown} text a name
 * @returns {string} the name to compare
 */
const fold = (text) => String(text).normalize('NFC').toLocaleLowerCase().trim();

/**
 * The lock a message means: its id or its name (without case; an exact name wins over a part of one), or the only one.
 *
 * @param {unknown} lock "lock" of the message
 * @param {{id: string, name: string}[]} locks the locks with PIN management
 * @returns {string} the lock id
 */
function findLock(lock, locks) {
  const names = locks.map((l) => l.name || l.id);
  const text = lock == null ? '' : String(lock).trim();
  if (!text) {
    if (locks.length === 1) {
      return locks[0].id;
    }
    if (!locks.length) {
      throw new AccessError('No lock with PIN management is known', 'NOT_FOUND', []);
    }
    throw new AccessError(`Several locks: name one with "lock" (${names.join(', ')})`, 'AMBIGUOUS', names);
  }
  const byId = locks.find((l) => l.id === text);
  if (byId) {
    return byId.id;
  }
  const wanted = fold(text);
  let found = locks.filter((l) => l.name && fold(l.name) === wanted);
  if (!found.length) {
    found = locks.filter((l) => l.name && fold(l.name).includes(wanted));
  }
  if (found.length === 1) {
    return found[0].id;
  }
  if (found.length > 1) {
    const fits = found.map((l) => l.name);
    throw new AccessError(`"${text}" fits several locks (${fits.join(', ')})`, 'AMBIGUOUS', fits);
  }
  throw new AccessError(`No lock "${text}" (locks: ${names.join(', ')})`, 'NOT_FOUND', names);
}

/**
 * The lock of a code when the message names no lock: the only lock, else the one that has a code with this id.
 *
 * @param {number} id the code (PIN id)
 * @param {{id: string, name: string, pinIds: number[]}[]} locks the locks with their PIN ids
 * @returns {string} the lock id
 */
function findLockOfCode(id, locks) {
  if (locks.length <= 1) {
    return findLock('', locks);
  }
  const found = locks.filter((l) => l.pinIds.includes(id));
  if (found.length === 1) {
    return found[0].id;
  }
  const names = (found.length ? found : locks).map((l) => l.name || l.id);
  if (found.length > 1) {
    throw new AccessError(`Several locks have a code ${id}: name one with "lock"`, 'AMBIGUOUS', names);
  }
  throw new AccessError(`No lock has a code ${id} (getCodes lists them)`, 'NOT_FOUND', names);
}

/**
 * The id of a code in updateCode / deleteCode.
 *
 * @param {unknown} id "id" of the message
 * @returns {number} PIN id
 */
function codeId(id) {
  const value = id === '' || id == null ? NaN : Number(id);
  if (!Number.isInteger(value) || value < 0) {
    throw new AccessError('"id" is required: the id of the code (getCodes)', 'BAD_REQUEST');
  }
  return value;
}

/**
 * The PIN command and its message for a standard command.
 *
 * @param {string} command createCode, getCodes, updateCode or deleteCode
 * @param {Record<string, unknown>} msg the message
 * @param {string} lockId the lock (findLock / findLockOfCode)
 * @param {number} [id] the code of updateCode / deleteCode (codeId)
 * @returns {{command: string, message: Record<string, unknown>}} for PinManager.handleCommand
 */
function toPinCommand(command, msg, lockId, id) {
  /** @type {Record<string, unknown>} */
  const message = { lockId };
  if (command === 'createCode' && (msg.code == null || msg.code === '')) {
    throw new AccessError(
      '"code" is required: tedee cannot make a code, ask the user for one (5-8 digits)',
      'BAD_REQUEST',
    );
  }
  if (command === 'createCode' || command === 'updateCode') {
    for (const [from, to] of Object.entries(FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(msg, from)) {
        message[to] = msg[from];
      }
    }
  }
  if (command === 'updateCode' || command === 'deleteCode') {
    message.pinId = id;
  }
  return { command: ACCESS_COMMANDS[command], message };
}

/**
 * The answer of the catalog from the answer of the PIN command.
 *
 * @param {string} command createCode, getCodes, updateCode or deleteCode
 * @param {{lockId: string, pinId?: number, pins?: import('./pinManager').PinListEntry[]}} result answer of
 *   PinManager.handleCommand
 * @param {Record<string, unknown>} msg the message
 * @returns {Record<string, unknown>} the answer
 */
function toAccessAnswer(command, result, msg) {
  switch (command) {
    case 'getCodes':
      return {
        lock: result.lockId,
        codes: (result.pins || []).map((pin) => ({
          id: pin.id,
          name: pin.alias,
          active: pin.active,
          start: pin.validFrom,
          end: pin.validTo,
          dayStart: pin.dayStart,
          dayEnd: pin.dayEnd,
          weekdays: pin.weekdays,
          weekdaysText: pin.weekdaysText,
        })),
      };
    case 'createCode':
      return { id: result.pinId, code: String(msg.code), lock: result.lockId };
    default:
      return { ok: true, id: result.pinId, lock: result.lockId };
  }
}

module.exports = { ACCESS_COMMANDS, AccessError, findLock, findLockOfCode, codeId, toPinCommand, toAccessAnswer };
