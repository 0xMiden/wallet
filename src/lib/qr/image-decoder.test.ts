import { decodeQrImage } from './image-decoder';

const mockDecode = jest.fn();
jest.mock(
  'jsqr',
  () =>
    (...args: Parameters<typeof import('jsqr').default>) =>
      mockDecode(...args)
);

const pixels = new Uint8ClampedArray(16);
const mockRevoke = jest.fn();
let failLoad = false;

beforeEach(() => {
  jest.clearAllMocks();
  failLoad = false;
  pixels.fill(255);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:local-test' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: mockRevoke });
  jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value) {
    if (!value) return;
    Object.defineProperty(this, 'naturalWidth', { value: 2 });
    Object.defineProperty(this, 'naturalHeight', { value: 2 });
    queueMicrotask(() => this.dispatchEvent(new Event(failLoad ? 'error' : 'load')));
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ drawImage: jest.fn(), getImageData: () => ({ data: pixels, width: 2, height: 2 }) })
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('decodes image bytes locally and releases the object URL and pixel buffer', async () => {
  mockDecode.mockReturnValue({ data: 'key-pair-fixture' });
  await expect(decodeQrImage(new File(['image'], 'keys.png'))).resolves.toBe('key-pair-fixture');
  expect(mockRevoke).toHaveBeenCalledWith('blob:local-test');
  expect(pixels.every(value => value === 0)).toBe(true);
});

it('rejects images without a QR code', async () => {
  mockDecode.mockReturnValue(null);
  await expect(decodeQrImage(new File(['image'], 'blank.png'))).rejects.toThrow('invalidQrImage');
  expect(mockRevoke).toHaveBeenCalled();
});

it('releases unreadable images', async () => {
  failLoad = true;
  await expect(decodeQrImage(new File(['not image'], 'broken.png'))).rejects.toThrow('invalidQrImage');
  expect(mockDecode).not.toHaveBeenCalled();
  expect(mockRevoke).toHaveBeenCalled();
});
