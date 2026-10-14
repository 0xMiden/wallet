import { networkTargetIds } from './own-output-request';

const fromAttachment = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NetworkAccountTarget: { fromAttachment: (attachment: unknown) => fromAttachment(attachment) }
}));

const note = (...attachments: string[]) => ({ attachments: () => attachments });
const target = (id: string) => ({ targetId: () => ({ toString: () => id }) });

beforeEach(() => {
  fromAttachment.mockReset();
  fromAttachment.mockImplementation((attachment: string) => {
    if (attachment.startsWith('nat:')) return target(attachment.slice(4));
    throw new Error('decode network account target: attachment scheme 1 did not match expected type 2');
  });
});

it('collects each network target once, skipping other attachments', () => {
  const notes = [note('nat:0xaa', 'plain'), note('plain'), note('nat:0xbb', 'nat:0xaa')];
  expect(networkTargetIds(notes as never)).toEqual(['0xaa', '0xbb']);
});

it('returns no targets for notes without network-target attachments', () => {
  expect(networkTargetIds([note(), note('plain')] as never)).toEqual([]);
});

it('rethrows a WASM trap instead of treating it as another scheme', () => {
  fromAttachment.mockImplementation(() => {
    throw new WebAssembly.RuntimeError('unreachable');
  });
  expect(() => networkTargetIds([note('nat:0xaa')] as never)).toThrow(WebAssembly.RuntimeError);
});
