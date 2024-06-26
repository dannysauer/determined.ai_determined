import dayjs, { Dayjs } from 'dayjs';
import { forEach, map, reduce, trimEnd } from 'lodash';

import rootLogger from 'utils/Logger';

import { decode_keys, KeyCache } from './keyCache';

import { Streamable, StreamContent, StreamEntityMap, StreamSpec } from '.';

const logger = rootLogger.extend('services', 'stream');

// About 60 seconds of auto-retry.
const backoffs = [0, 1, 2, 4, 8, 10, 10, 10, 15];

interface Subscription {
  spec: StreamSpec;
  // id is user defined, can be anything, only used to track if the subscription has been loaded.
  id?: string;
}

interface SubscriptionWithCache extends Subscription {
  keyCache: KeyCache;
}

type SubscriptionGroup = Partial<Record<Streamable, Subscription>>;

export class Stream {
  readonly #wsUrl: string;
  #ws?: WebSocket = undefined;
  #retries: number = 0;
  #timeout: Dayjs = dayjs();
  #numSyncs: number = 0;
  #closedByClient: boolean = false;

  #subs: Array<SubscriptionGroup> = [];
  #curSub?: Partial<Record<Streamable, SubscriptionWithCache>>;

  // syncSent updates when msg sent to the stream
  #syncSent?: string = undefined;
  // syncStarted updates when recieving msg of {sync_id, complated: false}
  #syncStarted?: string = undefined;
  // syncStarted updates when recieving msg of {sync_id, complated: true}
  #syncComplete?: string = undefined;
  // List of messages recieved from server
  #pendingMsg: Array<Record<string, StreamContent>> = [];

  //callbacks
  #onUpsert: (m: Record<string, StreamContent>) => void;
  #onDelete: (s: Streamable, a: Array<number>) => void;
  #isLoaded?: (ids: Array<string>) => void;

  constructor(
    wsUrl: string,
    onUpsert: (m: Record<string, StreamContent>) => void,
    onDelete: (s: Streamable, a: Array<number>) => void,
    isLoaded?: (ids: Array<string>) => void,
  ) {
    this.#wsUrl = wsUrl;
    this.#onUpsert = onUpsert;
    this.#onDelete = onDelete;
    this.#isLoaded = isLoaded;
    this.#advance();
  }

  #connect(): WebSocket {
    const ws = new WebSocket(this.#wsUrl);
    ws.onopen = () => {
      logger.info('Streaming websocket opened!');
      this.#retries = 0;
      this.#advance();
    };
    ws.onerror = (err) => {
      // No need to do anything else becauses onerror will trigger onclose
      logger.error('Streaming websocket errored: ', err);
    };

    ws.onclose = () => {
      this.#syncSent = undefined;
      const backoff = backoffs[this.#retries];
      if (backoff === undefined) {
        throw new Error('Websocket cannot reconnect!');
      }
      this.#timeout = dayjs().add(backoff, 'second');
      this.#retries += 1;
      logger.info(`#${this.#retries} of retries: in ${backoff}s`);
      setTimeout(() => this.#advance(), backoff * 1000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as Record<string, StreamContent>;
      this.#pendingMsg.push(msg);
      this.#advance();
    };

    return ws;
  }

  #shouldSkip(newSub: SubscriptionGroup): boolean {
    if (!this.#curSub) return false;
    let skip = true;
    forEach(newSub, (val, k) => {
      if (!this.#curSub?.[k as Streamable]?.spec.equals(val?.spec)) skip = false;
    });
    return skip;
  }

  #sendSpec(newSub: SubscriptionGroup): void {
    const newSpecWithCache: Partial<Record<Streamable, SubscriptionWithCache>> = {};
    this.#numSyncs += 1;
    const sync_id = this.#numSyncs.toString();

    const wholeSub = this.#curSub ? { ...this.#curSub, ...newSub } : newSub;

    const payload = reduce(
      wholeSub,
      (payload, ent) => {
        if (!ent) return payload;
        const k = ent.spec.id();
        const curSpec = this.#curSub?.[k];
        const keyCache = curSpec?.keyCache || new KeyCache();
        newSpecWithCache[k] = { ...ent, keyCache };
        payload['known'][k] = keyCache.known();
        payload['subscribe'][k] = {
          ...ent.spec.toWire(),
          since: keyCache.maxSeq(),
        };
        return payload;
      },
      { known: {}, subscribe: {}, sync_id: sync_id } as Record<string, StreamContent>,
    );

    this.#curSub = newSpecWithCache;
    this.#ws!.send(JSON.stringify(payload));
    this.#syncSent = sync_id;
  }

  #processPending(): void {
    while (this.#pendingMsg.length > 0) {
      const msg = this.#pendingMsg.shift();
      if (!msg) break;
      if (msg['sync_id']) {
        if (!msg['complete']) {
          this.#syncStarted = msg['sync_id'];
        } else {
          this.#handleSubFinish(this.#curSub!);
          this.#syncComplete = msg['sync_id'];
        }
      } else if (this.#syncSent !== this.#syncStarted) {
        // Ignore all messages between when we send a new subscription and when the
        // sync-start message for that subscription arrives.  These are the online
        // updates for a subscription we no longer care about.
      } else {
        forEach(msg, (val, k) => {
          if (k.includes('_deleted')) {
            const stream_key = trimEnd(k, '_deleted') as Streamable;
            const deleted_keys = decode_keys(val as string);

            this.#curSub?.[stream_key]?.keyCache.delete_msg(deleted_keys);
            this.#onDelete(stream_key, deleted_keys);
          } else {
            this.#curSub?.[StreamEntityMap[k]]?.keyCache.upsert([val.id], val.seq);
            this.#onUpsert(msg);
          }
        });
      }
    }
  }

  #processSubscription() {
    if (!this.#curSub && this.#subs.length === 0) return;

    let spec: SubscriptionGroup | undefined;

    if (!this.#syncSent) {
      // The websocket just connected/reconnected
      // Resend current subscription if current sync not completed
      if (this.#curSub && (!this.#syncComplete || this.#syncStarted !== this.#syncComplete)) {
        spec = this.#curSub;
      } else {
        spec = this.#subs.shift();
      }
      spec && this.#sendSpec(spec);
      return;
    }

    // have we finished offline messages for the current subscription?
    if (this.#syncComplete !== this.#syncSent) return;

    /* eslint-disable-next-line no-cond-assign */
    while ((spec = this.#subs.shift())) {
      // is this subscription worth sending?
      if (this.#shouldSkip(spec)) {
        this.#handleSubFinish(spec);
        continue;
      }
      // we have a fresh spec to send
      this.#sendSpec(spec);
      return;
    }
  }

  #advance(): void {
    if (this.#closedByClient) {
      // We want to shut down
      if (this.#ws && this.#ws.readyState !== this.#ws.CLOSED) {
        if (this.#ws.readyState !== this.#ws.CLOSING) {
          this.#ws.close();
        }
      }
      return;
    }

    if (this.#ws && this.#ws.readyState === this.#ws.CLOSED) {
      // Our websocket broke and we wait till timeout finish to reconnect
      if (dayjs().isBefore(this.#timeout)) return;
      this.#ws = undefined;
    }

    if (!this.#ws) {
      this.#ws = this.#connect();
    }

    if (this.#ws.readyState !== this.#ws.OPEN) {
      return;
    }
    this.#processPending();
    this.#processSubscription();
  }

  #handleSubFinish(spec: Partial<Record<Streamable, Subscription>>): void {
    this.#isLoaded?.(map(spec, (s) => s?.id || '').filter((i) => !!i));
  }

  public subscribe(spec: StreamSpec, id?: string): void {
    this.#subs.push({ [spec.id()]: { id, spec } });
    this.#advance();
  }

  public close(): void {
    this.#closedByClient = true;
    this.#advance();
  }
}
