/**
 * The class strings of the deposit-address mock-up (bread-deposit-R.html), one constant for each
 * mock-up class, with the mock-up's values. Colours are the wallet's theme tokens with the same
 * values. Sizes that the wallet has no type style for are written here once, so each value has one
 * place. The comment on each constant names the mock-up class.
 */
import type { DepositLayout } from './types';

/** `body`: Nunito 16/22, `ink`. Every deposit view starts from this base. */
export const BASE = 'face-heading font-heading text-[16px] leading-[22px] text-ink';

/** The space from the `PageHeader` rule to the content: the mock-up's top padding less the 8px under the rule. */
export const TOP_AFTER_HEADER: {
  amount: Record<DepositLayout, string>;
  body: Record<DepositLayout, string>;
  addressMobile: string;
  processing: string;
} = {
  /** `.b3` padding-top 26px. */
  amount: { mobile: 'pt-[18px]', extension: 'pt-[18px]' },
  /** `.body` padding-top 16px, 12px in the extension. */
  body: { mobile: 'pt-2', extension: 'pt-1' },
  /** `.h8` padding-top 18px. */
  addressMobile: 'pt-2.5',
  /** `viewProcessing`'s `.body` padding-top 32px. */
  processing: 'pt-6'
};

/** `.body`: a column with 12px between items, 16px under the last one. */
export const BODY_STACK = 'flex flex-col gap-3 pb-4';

// Amount screen

/** `.lab3`: 22/26 bold, `muted`. */
export const LAB3 = 'text-[22px] leading-[26px] font-bold text-muted';
/** `.n3`: 64/72 extrabold, -0.01em, tabular figures. */
export const N3 =
  'mt-3 w-full border-0 bg-transparent p-0 text-[64px] leading-[72px] font-extrabold tracking-[-0.01em] tabular-nums text-ink outline-none placeholder:text-muted placeholder:opacity-50';
/** `.phone.ext .n3`: 48/56, 6px above. */
export const N3_EXT = 'mt-1.5 text-[48px] leading-[56px]';
/** `.est3`: 14/20 semibold, `muted`, 14px under it (10px in the extension). */
export const EST3 = 'mb-3.5 min-h-5 text-[14px] leading-5 font-semibold tabular-nums text-muted';
export const EST3_EXT = 'mb-2.5';
/** `.tk4`: the 44px token-and-network button on `page` with a 1.5px `fill-pressed` edge. */
export const TK4 =
  'inline-flex h-11 shrink-0 self-start rounded-[22px] border-[1.5px] border-fill-pressed bg-page text-[17px] font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.tk4 .sg` (first segment). */
export const TK4_SEG = 'flex items-center gap-2 pr-3 pl-[7px]';
/** `.tk4 .sg + .sg`. */
export const TK4_SEG_NEXT = 'flex items-center gap-2 border-l-[1.5px] border-fill-pressed pr-3 pl-2.5';
/** `.tk4 svg`: 14px. */
export const ICON_14 = 'size-3.5 shrink-0';
/** `.tk4 .logo.sm`: 28px. */
export const LOGO_28 = '!h-7 !w-7';
/** `.rc3`: the receipt card. 24px above it (14px in the extension). */
export const RC3 = 'mt-6 rounded-2xl border border-hairline bg-page px-4 py-1';
export const RC3_EXT = 'mt-3.5';
/** `.rc3 > div`. */
export const RC3_ROW = 'flex min-h-12 items-center justify-between gap-3 py-3';
/** `.phone.ext .rc3 > div`. */
export const RC3_ROW_EXT = 'min-h-[42px] py-2';
/** `.rc3 > div + div`. */
export const RULE_TOP = 'border-t border-hairline';
/** `.rc3 span`. */
export const ROW_LABEL = 'text-muted';
/** `.rc3 b`. */
export const RC3_VALUE = 'inline-flex items-center gap-2.5 text-right font-bold tabular-nums text-ink';
/** `.chg`: the Change pill on the Route row. */
export const CHG =
  'inline-flex h-8 items-center gap-1 rounded-2xl bg-fill pr-2.5 pl-3 text-[14px] font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.chg svg`: 12px. */
export const ICON_12 = 'size-3 shrink-0';
/** `.rc3 > .tot`: the ruled total. */
export const TOT = 'flex items-start justify-between gap-3 border-t-2 border-ink pt-4 pb-3.5';
/** `.phone.ext .rc3 > .tot`. */
export const TOT_EXT = 'pt-3 pb-2.5';
/** `.rc3 .tot > span`. */
export const TOT_LABEL = 'whitespace-nowrap pt-[5px] font-extrabold text-ink';
/** `.rc3 .tot b`: 26/32 extrabold. */
export const TOT_VALUE =
  'flex flex-col items-end text-right text-[26px] leading-8 font-extrabold tabular-nums text-ink';
/** The inline 20px the mock-up sets on a total longer than 8 characters. */
export const TOT_VALUE_LONG = 'text-[20px]';
/** `.rc3 .tot small`. */
export const TOT_SMALL = 'min-h-[17px] text-[13px] leading-[17px] font-semibold text-muted';

// Notices

/** `.notice` in the phone: no surface, 13/17 `muted`, 16px `muted` glyph. */
export const NOTICE = 'flex gap-2 px-1 text-[13px] leading-[17px] text-muted';
export const NOTICE_ICON = 'size-4 shrink-0 text-muted';
/** `.notice.big` in the phone: on `fill`, 15/20 `ink`, 20px glyph. */
export const NOTICE_BIG = 'flex gap-2.5 rounded-2xl bg-fill py-3.5 pr-4 pl-3.5 text-[15px] leading-5 text-ink';
export const NOTICE_BIG_ICON = 'mt-px size-5 shrink-0 text-muted';
/** `.notice.big b`. */
export const NOTICE_BIG_TITLE = 'block text-[17px] leading-[22px] font-extrabold text-ink';
/** `.notice.neg`: `negative-ink` at 8% (12% in dark), 13/17 `ink`. */
export const NOTICE_NEG =
  'flex gap-2 rounded-2xl bg-negative-ink/8 py-3.5 pr-3.5 pl-3 text-[13px] leading-[17px] text-ink dark:bg-negative-ink/12';
export const NOTICE_NEG_ICON = 'size-4 shrink-0 text-negative-ink';
/** `.notice.neg b`. */
export const NOTICE_NEG_TITLE = 'block text-[14px] leading-[18px] font-bold text-negative-ink';
/** `.note`: 14/20 semibold `muted`. */
export const NOTE = 'px-1 text-[14px] leading-5 font-semibold text-muted';

// Review

/** `.heroA`. */
export const HERO_A = 'flex flex-col items-center gap-1.5 pt-0.5 pb-1 text-center';
/** `.heroA .lab`. */
export const HERO_A_LABEL = 'mt-2 text-[15px] font-bold text-muted';
/** `.phone .heroA .a2`: 32/40 bold. */
export const HERO_A_AMOUNT = 'text-[32px] leading-10 font-bold tabular-nums text-ink [overflow-wrap:anywhere]';
/** `.heroA .usd`. */
export const HERO_A_USD = 'text-[16px] font-bold text-muted';
/** `.sendpill`. */
export const SENDPILL =
  'self-center rounded-full bg-fill px-3.5 py-2 text-center text-[14px] leading-5 font-semibold text-muted';
/** `.sendpill b`. */
export const SENDPILL_STRONG = 'font-extrabold text-ink';

// Detail card

/** `.dcard` (and `.phone .dcard.f`): `page`, a hairline edge. */
export const DCARD = 'rounded-2xl border border-hairline bg-page text-left';
/** `.dcard div`. */
export const DCARD_ROW = 'flex justify-between gap-3 px-4 py-3';
/** `.phone.ext .dcard.f div`. */
export const DCARD_ROW_EXT = 'py-[9px]';
/** `.dcard b`. */
export const DCARD_VALUE = 'text-right text-[17px] font-bold tabular-nums text-ink';

// Address, mobile

/** `.h8`. */
export const H8 = 'flex flex-col items-center pb-4 text-center';
/** `.lab8`: 18/24 bold `muted`. */
export const LAB8 = 'text-[18px] leading-6 font-bold text-muted';
/** `.lab8.s`. */
export const LAB8_S = 'mt-3.5 text-[16px] leading-[22px]';
/** `.amt8`: 1.05 line height, -0.02em; the size comes from `amountFontSize`. */
export const AMT8 =
  'mt-1.5 max-w-full text-center leading-[1.05] font-extrabold tracking-[-0.02em] tabular-nums text-ink [overflow-wrap:anywhere] disabled:cursor-default';
/** `.tok8`. */
export const TOK8 = 'mt-1.5 inline-flex items-center gap-2 text-[20px] leading-7 font-extrabold text-muted';
/** `.rcv8`. */
export const RCV8 =
  'mt-3.5 inline-flex items-center gap-[9px] rounded-full bg-fill py-2.5 pr-5 pl-[18px] text-[17px] leading-6 font-semibold tabular-nums text-muted';
/** `.rcv8 b`. */
export const RCV8_STRONG = 'inline-flex items-center gap-1.5 font-extrabold text-ink';
/** `.rule8`. */
export const RULE8 = 'mt-[18px] h-1 self-stretch rounded-full bg-fill';
/** `.adc8`. */
export const ADC8 =
  'mt-2 flex justify-center self-stretch rounded-2xl border border-hairline bg-page px-3 py-[18px] active:bg-fill disabled:cursor-default disabled:active:bg-page focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.adc8 .ad7`. */
export const AD7 =
  'flex min-w-0 flex-col items-center text-center text-[18px] leading-[27px] font-bold text-ink [overflow-wrap:anywhere]';
/** `.act8`. */
export const ACT8 = 'mt-3.5 flex gap-4';
/** `.a8`. */
export const A8 =
  'flex min-w-[76px] flex-col items-center gap-1.5 text-center text-[13px] leading-[18px] font-bold text-ink disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.a8 i`. */
export const A8_CIRCLE = 'grid size-14 place-items-center rounded-full bg-fill';
/** `.a8.lead i`: the send colour (`card-blue`). */
export const A8_CIRCLE_LEAD = 'bg-accent-send text-accent-send-on';
/** `.a8 i svg`: 20px. */
export const ICON_20 = 'size-5 shrink-0';
/** `.h8 .dcard`. */
export const H8_DCARD = 'mt-[18px] self-stretch';
/** `.h8 .notice`. */
export const H8_NOTICE = 'mt-4 self-stretch text-left';
/** `.wait4`: the waiting strip. */
export const WAIT4 = 'flex items-center gap-3 border-t border-hairline px-5 pt-3.5';
/** `.wait4 b`. */
export const WAIT4_TITLE = 'block text-[15px] leading-5 font-extrabold text-ink';
/** `.wait4 small`. */
export const WAIT4_SMALL = 'text-[13px] leading-[18px] font-semibold tabular-nums text-muted';
/** `.dot4`: 22px ring, `fill-pressed` with a send-colour top, one turn a second. */
export const DOT4 =
  'size-[22px] shrink-0 rounded-full border-[3px] border-fill-pressed border-t-accent-send motion-safe:animate-spin';

// Address, extension

/** `.phone.ext .qrcard`: 200px, white, a hairline edge, 10px inside (8px of it is the QR's own). */
export const QRCARD_EXT = 'size-[200px] shrink-0 self-center rounded-2xl border border-hairline bg-pure-white p-0.5';
/** `.qrcard` in a sheet: 248px. */
export const QRCARD = 'size-[248px] shrink-0 self-center rounded-2xl border border-hairline bg-pure-white p-0.5';
/** `.phone .chip.on.center`. */
export const CHIP_ON =
  'inline-flex h-8 items-center gap-1.5 self-center whitespace-nowrap rounded-2xl border border-ink bg-fill px-3 text-[14px] font-bold text-ink';
/** `.copy`: the address pill. */
export const COPY_PILL =
  'flex h-11 w-full shrink-0 items-center justify-center rounded-[22px] bg-fill font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';

// Home row

/** `.phone .pend`. */
export const PEND =
  'grid w-full grid-cols-[36px_1fr_auto] items-center gap-3 rounded-2xl bg-fill py-3 pr-3.5 pl-3 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.phone .pend .dot`. */
export const PEND_DOT = 'size-9 rounded-full border-4 border-page border-t-ink motion-safe:animate-spin';
/** `.pend b`. */
export const PEND_TITLE = 'block leading-5 font-extrabold';
/** `.pend small`. */
export const PEND_SMALL = 'text-[13px] leading-[17px] font-semibold';

// Sheets

/** `.sheet`: padding 20 16 30 (plus the safe area), 14px between items, at most 78% of the screen. */
export const SHEET = 'max-h-[78vh] gap-3.5 px-4 pt-5 pb-[calc(30px+env(safe-area-inset-bottom))]';
/** `.sheet .hd`. */
export const SHEET_HEAD = 'flex items-center justify-between';
/** `.x32`: a 32px `fill` circle with an 18px `ink` glyph. */
export const X32 =
  'grid size-8 shrink-0 place-items-center rounded-full bg-fill text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.x32 svg`. */
export const ICON_18 = 'size-[18px] shrink-0';
/** `.rule` in a sheet: 4px on `fill`. */
export const SHEET_RULE = 'h-1 shrink-0 rounded-full bg-fill';
/** The sheet's items under the rule, 14px apart; they scroll when the sheet is full. */
export const SHEET_BODY = 'flex min-h-0 flex-col gap-3.5 overflow-y-auto overscroll-y-contain';
/** `.scrim`: black at 40%. */
export const SCRIM = 'bg-pure-black/40';
/** `.sheet .hd h2`: 28/34 extrabold. */
export const SHEET_TITLE = 'text-[28px] leading-[34px] font-extrabold text-ink';
/** `.lgroup`. */
export const LGROUP = 'overflow-hidden rounded-2xl bg-fill';
/** `.lg`. */
export const LG =
  'grid w-full grid-cols-[40px_1fr_auto] items-center gap-3 px-4 py-3 text-left font-bold text-ink active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary disabled:cursor-default disabled:opacity-50';
/** `.opt5.sep6`. */
export const OPT5 =
  'grid w-full grid-cols-[22px_1fr_auto] items-start gap-x-3 gap-y-px rounded-2xl bg-fill py-3.5 pr-4 pl-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.opt5.sep6[aria-pressed="true"]`. */
export const OPT5_SELECTED =
  'bg-page shadow-[0_0_0_1px_var(--ds-hairline),0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08)]';
/** `.opt5 > i`. */
export const OPT5_MARK =
  'row-span-2 mt-px grid size-[22px] place-items-center rounded-full border-2 border-[color-mix(in_srgb,var(--ds-ink)_28%,transparent)]';
/** `.opt5[aria-pressed="true"] > i`. */
export const OPT5_MARK_ON = 'border-0 bg-accent-send text-accent-send-on';
/** `.opt5 b`. */
export const OPT5_STRONG = 'text-[17px] leading-6 font-bold tabular-nums text-ink';
/** `.opt5 small`. */
export const OPT5_SMALL = 'text-[14px] leading-5 font-normal tabular-nums text-muted';
/** `.opt5 .ft6`. */
export const FT6 = 'col-[2/-1] mt-2.5 flex min-h-6 items-center gap-1.5';
/** `.opt5 .tg`. */
export const TG =
  'h-6 whitespace-nowrap rounded-xl bg-page px-2.5 text-[12px] leading-6 font-bold text-ink shadow-[inset_0_0_0_1px_var(--ds-hairline)]';
/** `.opt5 .tg.k`. */
export const TG_K = 'bg-ink text-page shadow-none';

// Token sheet

/** `.search`: a 44px `fill` pill, 16px inside, a 20px `muted` glyph 10px from the field. */
export const SEARCH =
  'flex h-11 shrink-0 items-center gap-2.5 rounded-[22px] bg-fill px-4 font-semibold text-muted focus-within:shadow-[0_0_0_2px_var(--ds-ink)]';
/** `.search input`: 16/22 semibold `ink`, no frame. */
export const SEARCH_INPUT =
  'min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] leading-[22px] font-semibold text-ink outline-none placeholder:text-muted';
/** `.nets`: the network chips in one row that scrolls sideways, edge to edge over the sheet's 16px gutter. */
export const NETS = 'no-scrollbar -mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4';
/** `.chip`: 32px, `fill`, 14px bold, a 1px edge that shows only when pressed. */
export const CHIP =
  'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-2xl border border-transparent bg-fill px-3 text-[14px] font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.phone .chip[aria-pressed="true"]`: an `ink` edge. */
export const CHIP_PRESSED = 'border-ink';
/** `p.sec`: 13/18 bold `muted`, 12px above (none for the first) and 2px under. */
export const SEC = 'pt-3 pb-0.5 text-[13px] leading-[18px] font-bold text-muted first:pt-0';
/** `.asset`: logo, name and subtitle, mark; 10px above and under. */
export const ASSET =
  'grid w-full grid-cols-[36px_1fr_auto] items-center gap-2 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';
/** `.asset b`. */
export const ASSET_NAME = 'block leading-5 font-bold text-ink';
/** `.asset small`. */
export const ASSET_SMALL = 'text-[13px] leading-[19px] font-semibold text-muted';
// Field (not in the mock-up: the refund address of a NEAR Intents deposit from a chain with no wallet address)

/** The field: its label, the `.search` pill and a line under it, 6px apart. */
export const FIELD = 'flex flex-col gap-1.5';
/** The field's label: `p.sec` (13/18 bold `muted`), 4px in from the edge as `.note`. */
export const FIELD_LABEL = 'px-1 text-[13px] leading-[18px] font-bold text-muted';
/** The field's pill with an error: a 2px `negative-ink` edge, the shape of the `.search` focus edge. */
export const FIELD_BOX_ERROR =
  'shadow-[0_0_0_2px_var(--ds-negative-ink)] focus-within:shadow-[0_0_0_2px_var(--ds-negative-ink)]';
/** The line under the field: `.notice` type (13/17), `muted`. */
export const FIELD_HINT = 'px-1 text-[13px] leading-[17px] font-semibold text-muted';
/** The error line under the field: `.notice.neg b` colour. */
export const FIELD_ERROR = 'px-1 text-[13px] leading-[17px] font-semibold text-negative-ink';

// Processing and success

/** `.body` of `viewProcessing` and `viewSuccess`: 16px between items. */
export const STATUS_STACK = 'flex flex-col gap-4 pb-4';
/** `viewSuccess`'s `.body` padding-top 40px (no header above it). */
export const SUCCESS_TOP = 'pt-10';
/** `.spin`: a 64px ring, 7px `fill-pressed` with a send-colour top, one turn a second. */
export const SPIN =
  'size-16 shrink-0 self-center rounded-full border-[7px] border-fill-pressed border-t-accent-send motion-safe:animate-spin';
/** `.phone .t24`: 22/28 extrabold, centred. */
export const T24 = 'text-center text-[22px] leading-7 font-extrabold text-ink';
/** `.phone .badge`: `fill`, 24px corners, 14px inside, 17/28 bold, items 10px apart. */
export const BADGE =
  'flex flex-wrap items-center justify-center gap-2.5 rounded-3xl bg-fill p-3.5 text-[17px] leading-7 font-bold text-ink';
/** `.badge span:first-child`: what was sent reads `muted`. */
export const BADGE_FROM = 'text-muted';
/** `.badge i`: a 24px `card-slate` disc with a white arrow. */
export const BADGE_ARROW =
  'grid size-6 place-items-center rounded-full bg-card-slate text-[14px] leading-none font-extrabold not-italic text-pure-white';
/** `.ps`: one step row, 14px 16px inside, the mark 12px from the text. */
export const PS = 'flex items-center gap-3 px-4 py-3.5 font-bold text-ink';
/** `.ps.wait`. */
export const PS_WAIT = 'text-muted';
/** `.ps i`: a 22px ring, 3px `fill-pressed`. */
export const PS_MARK = 'grid size-[22px] shrink-0 place-items-center rounded-full border-[3px] border-fill-pressed';
/** `.ps.done i`: the send colour, filled, with a 14px check. */
export const PS_MARK_DONE = 'border-0 bg-accent-send text-accent-send-on';
/** `.ps.now i`: the send colour ring, open at the top, one turn a second. */
export const PS_MARK_NOW = 'border-accent-send border-t-transparent motion-safe:animate-spin';
/** `.okc`: an 88px send-colour disc. */
export const OKC =
  'grid size-[88px] shrink-0 place-items-center self-center rounded-full bg-accent-send text-accent-send-on';
/** `.okc svg`: 44px. */
export const ICON_44 = 'size-11 shrink-0';
