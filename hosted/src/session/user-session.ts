import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { SessionBook, type CloseClaim, type LoggedAction, type NewAction, type OpenSession } from "./book";

/** One Durable Object per GitHub user. Holds the open session and its action log. */
export class UserSession extends DurableObject<Env> {
  async start(session: OpenSession): Promise<OpenSession> {
    const book = await this.load();
    const opened = book.start(session);
    await this.save(book);
    return opened;
  }

  async getOpen(): Promise<OpenSession | null> {
    return (await this.load()).getOpen();
  }

  async log(sessionId: string, action: NewAction): Promise<LoggedAction> {
    const book = await this.load();
    const stored = book.log(sessionId, action);
    await this.save(book);
    return stored;
  }

  async list(sessionId: string): Promise<LoggedAction[]> {
    return (await this.load()).list(sessionId);
  }

  async touch(sessionId: string, at: string): Promise<void> {
    const book = await this.load();
    book.touch(sessionId, at);
    await this.save(book);
  }

  async setAgentName(sessionId: string, name: string): Promise<void> {
    const book = await this.load();
    book.setAgentName(sessionId, name);
    await this.save(book);
  }

  async close(sessionId: string): Promise<void> {
    const book = await this.load();
    book.close(sessionId);
    await this.save(book);
  }

  async claimClose(sessionId?: string): Promise<CloseClaim> {
    const book = await this.load();
    const claim = book.claimClose(sessionId);
    await this.save(book);
    return claim;
  }

  async abortClose(sessionId: string): Promise<void> {
    const book = await this.load();
    book.abortClose(sessionId);
    await this.save(book);
  }

  async abandon(sessionId: string): Promise<void> {
    const book = await this.load();
    book.abandon(sessionId);
    await this.save(book);
  }

  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async load(): Promise<SessionBook> {
    const raw = await this.ctx.storage.get("book");
    return SessionBook.fromUnknown(raw);
  }

  private async save(book: SessionBook): Promise<void> {
    await this.ctx.storage.put("book", book.toJSON());
  }
}
