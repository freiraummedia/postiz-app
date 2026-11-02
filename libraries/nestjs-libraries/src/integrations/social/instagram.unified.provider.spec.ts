import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramUnifiedProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.unified.provider';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { NotEnoughScopes } from '@gitroom/nestjs-libraries/integrations/social.abstract';

const GRAPH = 'https://graph.facebook.com/v25.0';
const TOKEN = 'BISU_TOKEN';
const IG_ID = '17841400000000001';

type Route = {
  match: (url: string, init?: RequestInit) => boolean;
  body: any;
};

// Answers every request from a list of routes and records the calls, so a
// test can assert the exact Graph API sequence.
const mockGraph = (routes: Route[]) => {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || 'GET' });
    const route = routes.find((r) => r.match(url, init));
    if (!route) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return new Response(JSON.stringify(route.body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
};

const post = (path: string) => (url: string, init?: RequestInit) =>
  init?.method === 'POST' && url.startsWith(`${GRAPH}/${path}`);
const get = (path: string) => (url: string, init?: RequestInit) =>
  (init?.method || 'GET') === 'GET' && url.startsWith(`${GRAPH}/${path}`);

const integration: any = {
  id: 'integration-1',
  internalId: IG_ID,
  profile: 'xenobase.official',
};

const postDetails = (media: { path: string }[]) =>
  [
    {
      id: 'post-1',
      message: 'Hello from Postiz',
      settings: { post_type: 'post', collaborators: [] },
      media,
    },
  ] as any;

const env = { ...process.env };

beforeEach(() => {
  process.env.FRONTEND_URL = 'https://social.example.com';
  process.env.FACEBOOK_APP_ID = '1000';
  process.env.FACEBOOK_APP_SECRET = 'secret';
  process.env.INSTAGRAM_UNIFIED_CONFIG_ID = '2000';
});

afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe('InstagramUnifiedProvider login', () => {
  it('builds the Facebook Login for Business URL with config_id and without scope', async () => {
    const { url, state } =
      await new InstagramUnifiedProvider().generateAuthUrl();
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      'https://www.facebook.com/v25.0/dialog/oauth'
    );
    expect(parsed.searchParams.get('client_id')).toBe('1000');
    expect(parsed.searchParams.get('config_id')).toBe('2000');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://social.example.com/integrations/social/instagram-unified'
    );
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.has('scope')).toBe(false);
  });

  it('refuses to build a login URL without INSTAGRAM_UNIFIED_CONFIG_ID', async () => {
    delete process.env.INSTAGRAM_UNIFIED_CONFIG_ID;
    const provider = new InstagramUnifiedProvider();

    expect(provider.isEnabled()).toBe(false);
    await expect(provider.generateAuthUrl()).rejects.toThrow(
      'INSTAGRAM_UNIFIED_CONFIG_ID'
    );
  });

  it('exchanges the code and keeps the system user token', async () => {
    const calls = mockGraph([
      {
        match: get('oauth/access_token'),
        body: { access_token: TOKEN, token_type: 'bearer' },
      },
      {
        match: get('me/permissions'),
        body: {
          data: [
            { permission: 'instagram_basic', status: 'granted' },
            { permission: 'instagram_content_publish', status: 'granted' },
          ],
        },
      },
      {
        match: get('me?'),
        body: { id: '61500000000001', name: 'Postiz system user' },
      },
    ]);

    const auth = await new InstagramUnifiedProvider().authenticate({
      code: 'CODE',
      codeVerifier: '',
    });

    expect(auth).toEqual({
      id: '61500000000001',
      name: 'Postiz system user',
      accessToken: TOKEN,
      refreshToken: TOKEN,
      expiresIn: 0,
      picture: '',
      username: '',
    });

    const exchange = new URL(calls[0].url);
    expect(exchange.searchParams.get('client_id')).toBe('1000');
    expect(exchange.searchParams.get('client_secret')).toBe('secret');
    expect(exchange.searchParams.get('code')).toBe('CODE');
    expect(exchange.searchParams.get('redirect_uri')).toBe(
      'https://social.example.com/integrations/social/instagram-unified'
    );
  });

  it('stores the expiration when the configuration issues 60 day tokens', async () => {
    mockGraph([
      {
        match: get('oauth/access_token'),
        body: { access_token: TOKEN, expires_in: 5184000 },
      },
      {
        match: get('me/permissions'),
        body: {
          data: [
            { permission: 'instagram_basic', status: 'granted' },
            { permission: 'instagram_content_publish', status: 'granted' },
          ],
        },
      },
      { match: get('me?'), body: { id: '1', name: 'n' } },
    ]);

    const auth: any = await new InstagramUnifiedProvider().authenticate({
      code: 'CODE',
      codeVerifier: '',
    });
    expect(auth.expiresIn).toBe(5184000);
  });

  it('returns the Meta error when the code exchange fails', async () => {
    mockGraph([
      {
        match: get('oauth/access_token'),
        body: { error: { message: 'Invalid verification code format.' } },
      },
    ]);

    await expect(
      new InstagramUnifiedProvider().authenticate({
        code: 'x',
        codeVerifier: '',
      })
    ).resolves.toBe('Invalid verification code format.');
  });

  it('rejects a configuration without content publishing', async () => {
    mockGraph([
      { match: get('oauth/access_token'), body: { access_token: TOKEN } },
      {
        match: get('me/permissions'),
        body: { data: [{ permission: 'instagram_basic', status: 'granted' }] },
      },
    ]);

    await expect(
      new InstagramUnifiedProvider().authenticate({
        code: 'x',
        codeVerifier: '',
      })
    ).rejects.toBeInstanceOf(NotEnoughScopes);
  });
});

describe('InstagramUnifiedProvider account selection', () => {
  const accountRoutes = (): Route[] => [
    {
      match: (url) =>
        url.includes('assigned_instagram_accounts') && !url.includes('after=2'),
      body: {
        data: [{ id: IG_ID, username: 'xenobase.official' }],
        paging: { next: `${GRAPH}/me/assigned_instagram_accounts?after=2` },
      },
    },
    {
      match: (url) => url.includes('assigned_instagram_accounts?after=2'),
      body: { data: [{ id: '17841400000000002', username: 'second' }] },
    },
    {
      match: get(IG_ID),
      body: {
        id: IG_ID,
        username: 'xenobase.official',
        name: 'Xenobase',
        profile_picture_url: 'https://cdn.example.com/a.jpg',
      },
    },
    {
      match: get('17841400000000002'),
      body: { id: '17841400000000002', username: 'second' },
    },
  ];

  it('lists every Instagram account shared with the portfolio, across pages', async () => {
    mockGraph(accountRoutes());

    const pages = await new InstagramUnifiedProvider().pages(TOKEN);

    expect(pages).toEqual([
      {
        pageId: IG_ID,
        id: IG_ID,
        name: 'Xenobase',
        username: 'xenobase.official',
        picture: { data: { url: 'https://cdn.example.com/a.jpg' } },
      },
      {
        pageId: '17841400000000002',
        id: '17841400000000002',
        name: 'second',
        username: 'second',
        picture: { data: { url: '' } },
      },
    ]);
  });

  it('falls back to INSTAGRAM_UNIFIED_ACCOUNT_IDS when Meta lists no account', async () => {
    process.env.INSTAGRAM_UNIFIED_ACCOUNT_IDS = ` ${IG_ID} ,`;
    mockGraph([
      {
        match: (url) => url.includes('assigned_instagram_accounts'),
        body: { data: [] },
      },
      ...accountRoutes().slice(2),
    ]);

    const pages = await new InstagramUnifiedProvider().pages(TOKEN);

    expect(pages.map((p) => p.id)).toEqual([IG_ID]);
    expect(pages[0].username).toBe('xenobase.official');
  });

  it('stores the selected account with the system user token', async () => {
    mockGraph(accountRoutes());

    await expect(
      new InstagramUnifiedProvider().fetchPageInformation(TOKEN, {
        id: IG_ID,
        pageId: IG_ID,
      })
    ).resolves.toEqual({
      id: IG_ID,
      name: 'Xenobase',
      username: 'xenobase.official',
      picture: 'https://cdn.example.com/a.jpg',
      access_token: TOKEN,
    });
  });

  it('reconnects the same account and fails when it was not shared again', async () => {
    mockGraph(accountRoutes());
    const provider = new InstagramUnifiedProvider();

    await expect(provider.reConnect('x', IG_ID, TOKEN)).resolves.toMatchObject({
      id: IG_ID,
      accessToken: TOKEN,
      username: 'xenobase.official',
    });
    await expect(provider.reConnect('x', 'unknown', TOKEN)).rejects.toThrow();
  });
});

describe('InstagramUnifiedProvider publishing', () => {
  const runPublish = async (media: { path: string }[]) => {
    const provider = new InstagramUnifiedProvider();
    const [pending] = await provider.postPending(
      IG_ID,
      TOKEN,
      postDetails(media),
      integration
    );
    expect(pending.status).toBe('pending');

    let data = pending.pendingData;
    const steps: string[] = [];
    for (let i = 0; i < 10; i++) {
      const check = await provider.checkPostStatus(TOKEN, data, integration);
      steps.push(`check:${check.status}`);
      if (check.status === 'completed') {
        return { steps, result: check };
      }
      if (check.status === 'pending') {
        data = check.pendingData;
        continue;
      }
      const final = await provider.finalizePost(
        TOKEN,
        check.pendingData,
        integration
      );
      steps.push(`finalize:${final.status}`);
      if (final.status === 'completed') {
        return { steps, result: final };
      }
      data = final.pendingData;
    }
    throw new Error('did not finish');
  };

  // container status answers are consumed in order per container id
  const routesFor = (
    containers: Record<string, string[]>,
    extra: Route[] = []
  ) => {
    const routes: Route[] = [...extra];
    for (const [id, list] of Object.entries(containers)) {
      routes.push({
        match: (url, init) =>
          (init?.method || 'GET') === 'GET' &&
          url.startsWith(`${GRAPH}/${id}?`) &&
          url.includes('fields=status_code,status'),
        get body() {
          const status_code = list.length > 1 ? list.shift()! : list[0];
          return { status_code, status: status_code };
        },
      } as Route);
    }
    routes.push(
      { match: post(`${IG_ID}/media_publish`), body: { id: 'MEDIA_1' } },
      {
        match: get('MEDIA_1?fields=permalink'),
        body: { permalink: 'https://www.instagram.com/p/abc/' },
      }
    );
    return routes;
  };

  it('publishes a single image: container, status check, media_publish', async () => {
    const calls = mockGraph(
      routesFor({ C1: ['FINISHED'] }, [
        { match: post(`${IG_ID}/media?image_url`), body: { id: 'C1' } },
      ])
    );

    const { steps, result } = await runPublish([
      { path: 'https://uploads.example.com/a.jpg' },
    ]);

    expect(steps).toEqual(['check:ready', 'finalize:completed']);
    expect(result).toEqual({
      status: 'completed',
      postId: 'MEDIA_1',
      releaseURL: 'https://www.instagram.com/p/abc/',
    });

    const create = new URL(calls[0].url);
    expect(calls[0].method).toBe('POST');
    expect(create.host).toBe('graph.facebook.com');
    expect(create.searchParams.get('image_url')).toBe(
      'https://uploads.example.com/a.jpg'
    );
    expect(create.searchParams.get('caption')).toBe('Hello from Postiz');
    expect(create.searchParams.get('access_token')).toBe(TOKEN);
    expect(calls.map((c) => c.url).every((u) => u.startsWith(GRAPH))).toBe(
      true
    );
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.includes(`${IG_ID}/media_publish?creation_id=C1`)
      )
    ).toBe(true);
  });

  it('publishes a carousel through child containers and a CAROUSEL container', async () => {
    let child = 0;
    const calls = mockGraph(
      routesFor(
        {
          C1: ['FINISHED'],
          C2: ['FINISHED'],
          CAR: ['IN_PROGRESS', 'FINISHED'],
        },
        [
          {
            match: (url, init) => post(`${IG_ID}/media?image_url`)(url, init),
            get body() {
              child++;
              return { id: `C${child}` };
            },
          } as Route,
          { match: post(`${IG_ID}/media?caption`), body: { id: 'CAR' } },
        ]
      )
    );

    const { steps, result } = await runPublish([
      { path: 'https://uploads.example.com/a.jpg' },
      { path: 'https://uploads.example.com/b.jpg' },
    ]);

    expect(steps).toEqual([
      'check:ready',
      'finalize:pending',
      'check:pending',
      'check:ready',
      'finalize:completed',
    ]);
    expect(result.status).toBe('completed');

    const children = calls.filter((c) => c.url.includes('/media?image_url'));
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(new URL(c.url).searchParams.get('is_carousel_item')).toBe('true');
      expect(new URL(c.url).searchParams.has('caption')).toBe(false);
    }

    const carousel = new URL(
      calls.find((c) => c.url.includes('media_type=CAROUSEL'))!.url
    );
    expect(carousel.searchParams.get('children')).toBe('C1,C2');
    expect(carousel.searchParams.get('caption')).toBe('Hello from Postiz');
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' && c.url.includes('media_publish?creation_id=CAR')
      )
    ).toBe(true);
  });

  it('publishes a reel: REELS container, waits while IN_PROGRESS, then publishes', async () => {
    const calls = mockGraph(
      routesFor({ R1: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] }, [
        { match: post(`${IG_ID}/media?video_url`), body: { id: 'R1' } },
      ])
    );

    const { steps } = await runPublish([
      { path: 'https://uploads.example.com/clip.mp4' },
    ]);

    expect(steps).toEqual([
      'check:pending',
      'check:pending',
      'check:ready',
      'finalize:completed',
    ]);
    const create = new URL(calls[0].url);
    expect(create.searchParams.get('media_type')).toBe('REELS');
    expect(create.searchParams.get('video_url')).toBe(
      'https://uploads.example.com/clip.mp4'
    );
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' && c.url.includes('media_publish?creation_id=R1')
      )
    ).toBe(true);
  });
});

describe('existing Instagram providers are unchanged', () => {
  it('Instagram (Facebook Business) still asks for scopes', async () => {
    const { url } = await new InstagramProvider().generateAuthUrl();
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toContain('instagram_basic');
    expect(parsed.searchParams.has('config_id')).toBe(false);
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://social.example.com/integrations/social/instagram'
    );
  });

  it('Instagram (Standalone) still uses the Instagram login', async () => {
    process.env.INSTAGRAM_APP_ID = '3000';
    const { url } = await new InstagramStandaloneProvider().generateAuthUrl();
    expect(url.startsWith('https://www.instagram.com/oauth/authorize?')).toBe(
      true
    );
    expect(url).not.toContain('config_id');
  });

  it('hides the unified channel while INSTAGRAM_UNIFIED_CONFIG_ID is empty', async () => {
    delete process.env.INSTAGRAM_UNIFIED_CONFIG_ID;
    const manager = new IntegrationManager();
    const hidden = (await manager.getAllIntegrations()).social.map(
      (p) => p.identifier
    );

    expect(hidden).not.toContain('instagram-unified');
    expect(hidden).toContain('instagram');
    expect(hidden).toContain('instagram-standalone');
    // existing channels keep resolving to their provider
    expect(manager.getSocialIntegration('instagram-unified')).toBeInstanceOf(
      InstagramUnifiedProvider
    );

    process.env.INSTAGRAM_UNIFIED_CONFIG_ID = '2000';
    const shown = (await manager.getAllIntegrations()).social.map(
      (p) => p.identifier
    );
    expect(shown).toContain('instagram-unified');
    expect(shown.filter((p) => p !== 'instagram-unified')).toEqual(hidden);
  });
});
