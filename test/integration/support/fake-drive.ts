import type { MockAgent } from 'undici';
import type { MockInterceptor } from 'undici/types/mock-interceptor';

/**
 * An in-memory Google Drive behind undici's MockAgent: OAuth token refresh, folders, file reads
 * and resumable uploads assembled from their chunks. Switches simulate a full Drive and a
 * revoked grant (SPEC §16: Google mocked with MockAgent).
 */

const FOLDER = 'application/vnd.google-apps.folder';
const JSON_HEADERS = { 'content-type': 'application/json' };

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: Buffer;
  /** Not created by this service: invisible to the user's drive.file token. */
  foreign?: boolean;
  /** Shared "anyone with the link": readable with the API key. */
  public?: boolean;
}

type Reply = ReturnType<MockInterceptor.MockReplyOptionsCallback>;
type Request = MockInterceptor.MockResponseCallbackOptions;

const bodyBytes = (body: Request['body']): Buffer =>
  typeof body === 'string'
    ? Buffer.from(body)
    : body
      ? Buffer.from(body as Uint8Array)
      : Buffer.alloc(0);

export class FakeDrive {
  readonly files = new Map<string, FakeFile>();
  storageFull = false;
  revoked = false;
  private sessions = new Map<
    string,
    { name: string; mimeType: string; parents: string[]; total: number; received: Buffer }
  >();
  private next = 1;

  constructor(mock: MockAgent) {
    mock
      .get('https://oauth2.googleapis.com')
      .intercept({
        path: '/token',
        method: 'POST',
        body: (body) => body.includes('grant_type=refresh_token'),
      })
      .reply((): Reply =>
        this.revoked
          ? {
              statusCode: 400,
              data: { error: 'invalid_grant' },
              responseOptions: { headers: JSON_HEADERS },
            }
          : {
              statusCode: 200,
              data: { access_token: 'ya29.fake', expires_in: 3599, token_type: 'Bearer' },
              responseOptions: { headers: JSON_HEADERS },
            },
      )
      .persist();
    mock
      .get('https://www.googleapis.com')
      .intercept({ path: () => true, method: () => true })
      .reply((request) => this.handle(request))
      .persist();
  }

  /** Files and folders inside a folder, by name. */
  children(folderId: string): FakeFile[] {
    return [...this.files.values()].filter((file) => file.parents.includes(folderId));
  }

  byName(name: string): FakeFile | undefined {
    return [...this.files.values()].find((file) => file.name === name);
  }

  folder(name: string, parent?: string): FakeFile {
    const folder = {
      id: this.id(),
      name,
      mimeType: FOLDER,
      parents: parent === undefined ? [] : [parent],
    };
    this.files.set(folder.id, folder);
    return folder;
  }

  private handle(request: Request): Reply {
    const url = new URL(request.path, 'https://www.googleapis.com');
    if (url.pathname === '/drive/v3/files' && request.method === 'POST') {
      const meta = JSON.parse(bodyBytes(request.body).toString()) as {
        name: string;
        mimeType: string;
        parents?: string[];
      };
      return this.json(200, this.view(this.folder(meta.name, meta.parents?.[0])));
    }
    const fileMatch = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
    if (fileMatch && request.method === 'GET') {
      const file = this.visible(fileMatch[1] ?? '', request, url);
      if (!file) return this.json(404, { error: { code: 404, message: 'File not found' } });
      if (url.searchParams.get('alt') === 'media')
        return { statusCode: 200, data: file.content ?? Buffer.alloc(0) };
      return this.json(200, this.view(file));
    }
    if (url.pathname === '/upload/drive/v3/files' && request.method === 'POST')
      return this.startUpload(request);
    if (url.pathname === '/upload/drive/v3/files' && request.method === 'PUT')
      return this.putChunk(url, request);
    return this.json(400, {
      error: { code: 400, message: `unexpected ${request.method} ${url.pathname}` },
    });
  }

  /** drive.file tokens see the service's own files; the API key sees public ones. */
  private visible(id: string, request: Request, url: URL): FakeFile | undefined {
    const file = this.files.get(id);
    const headers = (request.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== undefined) return file?.foreign === true ? undefined : file;
    return url.searchParams.get('key') === 'test-api-key' && file?.public === true
      ? file
      : undefined;
  }

  /** A file someone else put in Drive. */
  foreignFile(name: string, content: Buffer, options: { public: boolean }): FakeFile {
    const file = {
      id: this.id(),
      name,
      mimeType: 'video/mp4',
      parents: [],
      content,
      foreign: true,
      public: options.public,
    };
    this.files.set(file.id, file);
    return file;
  }

  private startUpload(request: Request): Reply {
    if (this.storageFull) {
      return this.json(403, {
        error: {
          code: 403,
          message: 'Storage quota exceeded',
          errors: [{ reason: 'storageQuotaExceeded' }],
        },
      });
    }
    const meta = JSON.parse(bodyBytes(request.body).toString()) as {
      name: string;
      parents: string[];
    };
    const headers = (request.headers ?? {}) as Record<string, string>;
    const parent = this.files.get(meta.parents[0] ?? '');
    if (!parent) return this.json(404, { error: { code: 404, message: 'File not found' } });
    const session = this.id();
    this.sessions.set(session, {
      name: meta.name,
      mimeType: headers['x-upload-content-type'] ?? 'application/octet-stream',
      parents: meta.parents,
      total: Number(headers['x-upload-content-length'] ?? 0),
      received: Buffer.alloc(0),
    });
    return {
      statusCode: 200,
      data: '',
      responseOptions: {
        headers: {
          location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${session}`,
        },
      },
    };
  }

  private putChunk(url: URL, request: Request): Reply {
    const session = this.sessions.get(url.searchParams.get('upload_id') ?? '');
    if (!session)
      return this.json(404, { error: { code: 404, message: 'Upload session not found' } });
    const range = ((request.headers ?? {}) as Record<string, string>)['content-range'] ?? '';
    const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (chunk) session.received = Buffer.concat([session.received, bodyBytes(request.body)]);
    if (session.received.length < session.total) {
      return {
        statusCode: 308,
        data: '',
        responseOptions: { headers: { range: `bytes=0-${session.received.length - 1}` } },
      };
    }
    const file = {
      id: this.id(),
      name: session.name,
      mimeType: session.mimeType,
      parents: session.parents,
      content: session.received,
    };
    this.files.set(file.id, file);
    return this.json(200, this.view(file));
  }

  private view(file: FakeFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: file.parents,
      ...(file.mimeType !== FOLDER && {
        webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
        size: String(file.content?.length ?? 0),
      }),
    };
  }

  private json(statusCode: number, data: object): Reply {
    return { statusCode, data, responseOptions: { headers: JSON_HEADERS } };
  }

  private id(): string {
    return `fake${String(this.next++).padStart(10, '0')}`;
  }
}
