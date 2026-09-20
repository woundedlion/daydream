/** A worker-global endpoint that records structured-cloned outbound messages. */
export function fakeWorkerScope(posted) {
  return {
    postMessage(msg, transfer) {
      posted.push({ msg, transfer, received: structuredClone(msg, { transfer }) });
    },
    onmessage: null,
    onmessageerror: null,
  };
}

/** Web Worker constructor double shared by controller suites. */
export class FakeWorker {
  static instances = [];
  static constructionCount = 0;
  static failConstructionAt = -1;
  static failInitialPostAt = -1;
  static failPostAt = -1;
  static failPostType = null;

  constructor(url, opts) {
    this.index = FakeWorker.constructionCount++;
    if (this.index === FakeWorker.failConstructionAt)
      throw new DOMException('worker blocked', 'SecurityError');
    this.url = url;
    this.opts = opts;
    this.posted = [];
    this.transfers = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    FakeWorker.instances.push(this);
  }

  postMessage(msg, transfer) {
    if (msg.type === 'init' && this.index === FakeWorker.failInitialPostAt)
      throw new DOMException('message rejected', 'DataCloneError');
    if (msg.type === FakeWorker.failPostType && this.index === FakeWorker.failPostAt)
      throw new DOMException('message rejected', 'DataCloneError');
    structuredClone(msg, { transfer });
    this.posted.push(msg);
    this.transfers.push(transfer ?? null);
  }

  terminate() { this.terminated = true; }

  static reset() {
    FakeWorker.instances = [];
    FakeWorker.constructionCount = 0;
    FakeWorker.failConstructionAt = -1;
    FakeWorker.failInitialPostAt = -1;
    FakeWorker.failPostAt = -1;
    FakeWorker.failPostType = null;
  }
}
