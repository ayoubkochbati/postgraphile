import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Stream } from 'stream';
import { Context as KoaContext } from 'koa';

type Headers = { [header: string]: string };

/**
 * The base class for PostGraphile responses; collects headers, status code and
 * body, and then hands to the relevant adaptor at the correct time.
 */
export abstract class PostGraphileResponse {
  private _headers: Headers = {};
  private _body: Buffer | string | PassThrough | undefined;
  private _flushedHeaders: boolean = false;
  public statusCode: number = 200;

  private _flushHeadersOnce() {
    if (!this._flushedHeaders) {
      this._flushedHeaders = true;
      this.flushHeaders(this.statusCode, this._headers);
    }
  }

  public setHeader(header: string, value: string): void {
    if (this._flushedHeaders) {
      throw new Error(`Cannot set a header '${header}' when headers already sent`);
    }
    this._headers[header] = value;
  }

  /**
   * Use `getStream` or `end`; not both
   */
  public getStream(): PassThrough {
    if (this._body != null) {
      throw new Error("Cannot return a stream when there's already a response body");
    }
    this._flushHeadersOnce();
    this._body = new PassThrough();
    this.flushBody(this._body);
    return this._body;
  }

  /**
   * Use `getStream` or `end`; not both
   */
  public end(moreBody?: Buffer | string | null) {
    if (moreBody) {
      if (this._body != null) {
        if (typeof this._body === 'string') {
          if (Buffer.isBuffer(moreBody)) {
            throw new Error('Cannot mix string and buffer');
          }
          this._body = this._body + moreBody;
        } else if (Buffer.isBuffer(this._body)) {
          if (typeof moreBody === 'string') {
            throw new Error('Cannot mix buffer and string');
          }
          this._body = Buffer.concat([this._body, moreBody]);
        } else {
          throw new Error("Can't `.end(string)` when body is a stream");
        }
      } else {
        this._body = moreBody;
      }
    }
    this._flushHeadersOnce();
    this.flushBody(this._body);
  }

  /**
   * Returns the `res` object that the underlying HTTP server would have.
   */
  public abstract getNodeServerRequest(): IncomingMessage;
  public abstract getNodeServerResponse(): ServerResponse;
  public abstract flushHeaders(statusCode: number, headers: Headers): void;
  public abstract flushBody(body: Stream | Buffer | string | undefined): void;
}

/**
 * Suitable for Node's HTTP server, but also connect, express and restify.
 */
export class PostGraphileResponseNode extends PostGraphileResponse {
  private _req: IncomingMessage;
  private _res: ServerResponse;
  private _next: (e?: 'route' | Error) => void;

  constructor(req: IncomingMessage, res: ServerResponse, next: (e?: 'route' | Error) => void) {
    super();
    this._req = req;
    this._res = res;
    this._next = next;
  }

  getNodeServerRequest() {
    return this._req;
  }

  getNodeServerResponse() {
    return this._res;
  }

  flushHeaders(statusCode: number, headers: Headers) {
    for (const key in headers) {
      if (Object.hasOwnProperty.call(headers, key)) {
        this._res.setHeader(key, headers[key]);
      }
    }
    this._res.writeHead(statusCode);
    // support running within the compression middleware.
    // https://github.com/expressjs/compression#server-sent-events
    if (typeof (this._res as any).flushHeaders === 'function') (this._res as any).flushHeaders();
  }

  flushBody(body: Stream | Buffer | string | undefined) {
    if (typeof body === 'string') {
      this._res.end(body);
    } else if (Buffer.isBuffer(body)) {
      this._res.end(body);
    } else if (!body) {
      this._res.end();
    } else {
      // Must be a stream?
      body.pipe(this._res);
    }
  }
}

export type KoaNext = (error?: Error) => Promise<any>;

/**
 * Suitable for Koa.
 */
export class PostGraphileResponseKoa extends PostGraphileResponse {
  private _ctx: KoaContext;
  private _next: KoaNext;

  constructor(ctx: KoaContext, next: KoaNext) {
    super();
    this._ctx = ctx;
    this._next = next;
    const req = this.getNodeServerRequest();

    // For backwards compatibility (this is a documented interface)
    (req as any)._koaCtx = ctx;

    // Make `koa-bodyparser` trigger skipping of our `body-parser`
    if ((ctx.request as any).body) {
      (req as any)._body = true;
      (req as any).body = (ctx.request as any).body;
    }

    // In case you're using koa-mount or similar
    (req as any).originalUrl = ctx.request.originalUrl;
  }

  getNodeServerRequest() {
    return this._ctx.req;
  }

  getNodeServerResponse() {
    return this._ctx.res;
  }

  flushHeaders(statusCode: number, headers: Headers) {
    this._ctx.status = statusCode;
    Object.assign(this._ctx.headers, headers);
    this._ctx.flushHeaders();
  }

  flushBody(body: Stream | Buffer | string | undefined) {
    this._ctx.body = body;
    this._next();
  }
}
