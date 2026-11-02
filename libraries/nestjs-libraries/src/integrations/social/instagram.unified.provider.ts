import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import {
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { Integration } from '@prisma/client';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import { DashboardFunction } from '@gitroom/nestjs-libraries/integrations/dashboard.function.decorator';

const instagramProvider = new InstagramProvider();

// Instagram API with Unified Login: Facebook Login for Business with a
// configuration (config_id) instead of scopes. Meta apps created since late
// 2026 only offer this setup. The code is exchanged for a Business Integration
// System User token that belongs to the client's business portfolio, covers
// every Instagram account shared during the login and works without a
// Facebook Page.
// https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login
@Rules(
  "Instagram should have at least one attachment, if it's a story, it can have only one picture"
)
export class InstagramUnifiedProvider
  extends SocialAbstract
  implements SocialProvider
{
  identifier = 'instagram-unified';
  name = 'Instagram\n(Unified Login)';
  isBetweenSteps = true;
  toolTip =
    'Instagram must be a professional account in a Meta business portfolio';
  // the permissions come from the login configuration, these are only checked
  scopes = ['instagram_basic', 'instagram_content_publish'];
  override maxConcurrentJob = 400;
  editor = 'normal' as const;
  dto = InstagramDto;
  maxLength() {
    return 2200;
  }

  isEnabled() {
    return !!process.env.INSTAGRAM_UNIFIED_CONFIG_ID;
  }

  private redirectUri() {
    return `${process.env.FRONTEND_URL}/integrations/social/instagram-unified`;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    return instagramProvider.checkValidity(posts, settings);
  }

  public override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    return instagramProvider.handleErrors(body, status);
  }

  // The token either never expires or expires after 60 days, depending on the
  // login configuration. It cannot be refreshed by the app, the business has
  // to log in again.
  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    if (!process.env.INSTAGRAM_UNIFIED_CONFIG_ID) {
      throw new Error('INSTAGRAM_UNIFIED_CONFIG_ID is not set');
    }

    const state = makeSecureId(6);
    return {
      url:
        `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth` +
        `?client_id=${process.env.FACEBOOK_APP_ID}` +
        `&config_id=${process.env.INSTAGRAM_UNIFIED_CONFIG_ID}` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
        `&response_type=code` +
        `&state=${state}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const { access_token, expires_in, error } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token` +
          `?client_id=${process.env.FACEBOOK_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(this.redirectUri())}` +
          `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
          `&code=${encodeURIComponent(params.code)}`
      )
    ).json();

    if (!access_token) {
      return error?.message || 'Could not get an access token from Meta';
    }

    const { data } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/permissions?access_token=${access_token}`
      )
    ).json();

    if (Array.isArray(data)) {
      this.checkScopes(
        this.scopes,
        data
          .filter((d: any) => d.status === 'granted')
          .map((p: any) => p.permission)
      );
    }

    // with this token /me is the system user of the client's business
    const { id, name } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me?fields=id,name&access_token=${access_token}`
      )
    ).json();

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: +expires_in || 0,
      picture: '',
      username: '',
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const account = (await this.pages(accessToken)).find(
      (p) => p.id === requiredId
    );

    if (!account) {
      throw new Error(
        'The Instagram account was not shared during the login, please select it'
      );
    }

    return {
      id: account.id,
      name: account.name,
      accessToken,
      picture: account.picture.data.url,
      username: account.username,
    };
  }

  @DashboardFunction()
  async pages(accessToken: string) {
    const accounts: { id: string }[] = [];

    let nextUrl:
      | string
      | undefined = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/assigned_instagram_accounts?fields=id,username&limit=100&access_token=${accessToken}`;
    while (nextUrl) {
      const response: any = await (await fetch(nextUrl)).json();
      accounts.push(...(response.data || []));
      nextUrl = response.paging?.next;
    }

    return Promise.all(
      accounts.map(async (account) => {
        const information = await this.accountInformation(
          accessToken,
          account.id
        );
        return {
          pageId: information.id,
          id: information.id,
          name: information.name,
          username: information.username,
          picture: { data: { url: information.picture } },
        };
      })
    );
  }

  async fetchPageInformation(
    accessToken: string,
    data: { pageId: string; id: string }
  ) {
    const information = await this.accountInformation(accessToken, data.id);

    return {
      ...information,
      access_token: accessToken,
    };
  }

  private async accountInformation(accessToken: string, accountId: string) {
    const { id, name, username, profile_picture_url } = await (
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${accountId}?fields=id,username,name,profile_picture_url&access_token=${accessToken}`
      )
    ).json();

    return {
      id,
      name: name || username,
      username,
      picture: profile_picture_url || '',
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.post(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.postPending(
      id,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  // the graph domain travels inside pendingData, so these are pure delegations
  override async checkPostStatus(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.checkPostStatus(
      accessToken,
      pendingData,
      integration
    );
  }

  override async finalizePost(
    accessToken: string,
    pendingData: any,
    integration: Integration
  ) {
    return instagramProvider.finalizePost(
      accessToken,
      pendingData,
      integration
    );
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<InstagramDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return instagramProvider.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'graph.facebook.com'
    );
  }

  async analytics(id: string, accessToken: string, date: number) {
    return instagramProvider.analytics(
      id,
      accessToken,
      date,
      'graph.facebook.com'
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ) {
    return instagramProvider.postAnalytics(
      integrationId,
      accessToken,
      postId,
      date,
      'graph.facebook.com'
    );
  }
}
