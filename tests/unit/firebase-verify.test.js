/**
 * firebase-service.verifyIdToken: the only place that decides whether a Firebase ID
 * token is acceptable. The Admin SDK is mocked; nothing here touches the network.
 */

const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn(() => ({})) },
  firestore: jest.fn(() => ({})),
  messaging: jest.fn(() => ({})),
  auth: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const GOOD_TOKEN = 'x'.repeat(40);

function freshService() {
  jest.resetModules();
  return require('../../core/services/firebase-service');
}

describe('verifyIdToken', () => {
  const OLD_ENV = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  beforeEach(() => mockVerifyIdToken.mockReset());
  afterAll(() => { process.env.FIREBASE_SERVICE_ACCOUNT_KEY = OLD_ENV; });

  test('fails closed when Firebase is not initialised, without calling the SDK', async () => {
    const svc = freshService();
    await expect(svc.verifyIdToken(GOOD_TOKEN)).rejects.toMatchObject({ code: 'auth/not-initialized' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  describe('once initialised', () => {
    let svc;
    beforeEach(async () => {
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ project_id: 'proj-test' });
      svc = freshService();
      expect(await svc.initialize()).toBe(true);
    });

    test.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 12345],
      ['an object', {}],
      ['too short', 'abc'],
      ['too long', 'x'.repeat(5000)],
    ])('rejects a malformed token (%s) without calling the SDK', async (_label, value) => {
      await expect(svc.verifyIdToken(value)).rejects.toMatchObject({ code: 'auth/invalid-token' });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    test('returns only the minimal normalised identity, not the whole decoded token', async () => {
      mockVerifyIdToken.mockResolvedValue({
        uid: 'uid-123', aud: 'proj-test', email: 'a@b.com', email_verified: true, name: 'Ana',
        phone_number: '+51999999999', picture: 'https://x/y.png',
        firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['1'] } },
      });
      const id = await svc.verifyIdToken(GOOD_TOKEN);
      expect(id).toEqual({ uid: 'uid-123', provider: 'google.com', email: 'a@b.com', emailVerified: true, name: 'Ana' });
      expect(id).not.toHaveProperty('phone_number');
      expect(id).not.toHaveProperty('picture');
    });

    test('Apple identity with a hidden email still yields a uid', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'uid-apple', aud: 'proj-test', firebase: { sign_in_provider: 'apple.com' } });
      expect(await svc.verifyIdToken(GOOD_TOKEN)).toEqual({
        uid: 'uid-apple', provider: 'apple.com', email: null, emailVerified: false, name: null,
      });
    });

    test('rejects a token issued for another Firebase project', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'u', aud: 'another-project' });
      await expect(svc.verifyIdToken(GOOD_TOKEN)).rejects.toMatchObject({ code: 'auth/wrong-audience' });
    });

    test('rejects a decoded token without uid', async () => {
      mockVerifyIdToken.mockResolvedValue({ aud: 'proj-test' });
      await expect(svc.verifyIdToken(GOOD_TOKEN)).rejects.toMatchObject({ code: 'auth/invalid-token' });
    });

    test('propagates SDK failures (expired, revoked, bad signature)', async () => {
      mockVerifyIdToken.mockRejectedValue(Object.assign(new Error('expired'), { code: 'auth/id-token-expired' }));
      await expect(svc.verifyIdToken(GOOD_TOKEN)).rejects.toMatchObject({ code: 'auth/id-token-expired' });
    });
  });
});
