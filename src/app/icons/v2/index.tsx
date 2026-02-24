import React from 'react';

import classNames from 'clsx';

import { ReactComponent as LeoLogo } from '../leo-logo-blue.svg';
import { ReactComponent as AddCircle } from './add-circle.svg';
import { ReactComponent as Add } from './add.svg';
import { ReactComponent as AddressBook } from './address-book.svg';
import { ReactComponent as Apps } from './apps.svg';
import { ReactComponent as ArrowDown } from './arrow-down.svg';
import { ReactComponent as ArrowLeft } from './arrow-left.svg';
import { ReactComponent as ArrowRightDownFill } from './arrow-right-down-fill.svg';
import { ReactComponent as ArrowRightDownFilledCircle } from './arrow-right-down-filled-circle.svg';
import { ReactComponent as ArrowRightDown } from './arrow-right-down.svg';
import { ReactComponent as ArrowRightUpFill } from './arrow-right-up-fill.svg';
import { ReactComponent as ArrowRightUp } from './arrow-right-up.svg';
import { ReactComponent as ArrowRight } from './arrow-right.svg';
import { ReactComponent as ArrowUpDown } from './arrow-up-down.svg';
import { ReactComponent as ArrowUp } from './arrow-up.svg';
import { ReactComponent as Bell } from './bell.svg';
import { ReactComponent as Bin } from './bin.svg';
import { ReactComponent as Calendar } from './calendar.svg';
import { ReactComponent as CheckboxCircleFill } from './checkbox-circle-fill.svg';
import { ReactComponent as CheckboxCircle } from './checkbox-circle.svg';
import { ReactComponent as CheckboxFill } from './checkbox-fill.svg';
import { ReactComponent as Checkbox } from './checkbox.svg';
import { ReactComponent as Checkmark } from './checkmark.svg';
import { ReactComponent as ChevronDownLucide } from './chevron-down-lucide.svg';
import { ReactComponent as ChevronDown } from './chevron-down.svg';
import { ReactComponent as ChevronLeftLucide } from './chevron-left-lucide.svg';
import { ReactComponent as ChevronLeft } from './chevron-left.svg';
import { ReactComponent as ChevronRightLucide } from './chevron-right-lucide.svg';
import { ReactComponent as ChevronRight } from './chevron-right.svg';
import { ReactComponent as ChevronUp } from './chevron-up.svg';
import { ReactComponent as Circle } from './circle.svg';
import { ReactComponent as CloseCircleFill } from './close-circle-fill.svg';
import { ReactComponent as CloseCircle } from './close-circle.svg';
import { ReactComponent as Close } from './close.svg';
import { ReactComponent as Code } from './code.svg';
import { ReactComponent as CoinsFill } from './coins-fill.svg';
import { ReactComponent as Coins } from './coins.svg';
import { ReactComponent as ContactsBook } from './contacts-book.svg';
import { ReactComponent as Convert } from './convert.svg';
import { ReactComponent as Copy } from './copy.svg';
import { ReactComponent as DelegateProving } from './delegate-proving.svg';
import { ReactComponent as Download1 } from './download-1.svg';
import { ReactComponent as Download } from './download.svg';
import { ReactComponent as EmotionSad } from './emotion-sad.svg';
import { ReactComponent as EyeOff } from './eye-off.svg';
import { ReactComponent as Eye } from './eye.svg';
import { ReactComponent as FaceId } from './face-id.svg';
import { ReactComponent as Failed } from './failed.svg';
import { ReactComponent as FaucetFill } from './faucet-fill.svg';
import { ReactComponent as Faucet } from './faucet.svg';
import { ReactComponent as FileCopy } from './file-copy.svg';
import { ReactComponent as FileSettings } from './file-settings.svg';
import { ReactComponent as File } from './file.svg';
import { ReactComponent as Frown } from './frown.svg';
import { ReactComponent as Fullscreen } from './fullscreen.svg';
import { ReactComponent as GlobalFill } from './global-fill.svg';
import { ReactComponent as Globe } from './globe.svg';
import { ReactComponent as Hammer } from './hammer.svg';
import { ReactComponent as HomeFill } from './home-fill.svg';
import { ReactComponent as Home } from './home.svg';
import { ReactComponent as ImageFill } from './image-fill.svg';
import { ReactComponent as ImagePrivate } from './image-private.svg';
import { ReactComponent as ImagePublic } from './image-public.svg';
import { ReactComponent as Image } from './image.svg';
import { ReactComponent as InProgress } from './in-progress.svg';
import { ReactComponent as IndeterminateCircle } from './indeterminate-circle.svg';
import { ReactComponent as InformationFill } from './information-fill.svg';
import { ReactComponent as Information } from './information.svg';
import { ReactComponent as Key } from './key.svg';
import { ReactComponent as LeoLock } from './leo-lock.svg';
import { ReactComponent as LeoLogoAndName } from './leo-logo-and-name-horizontal.svg';
import { ReactComponent as List } from './list.svg';
import { ReactComponent as Loader } from './loader.svg';
import { ReactComponent as Loading } from './loading.svg';
import { ReactComponent as Lock } from './lock.svg';
import { ReactComponent as MidenLogoOrange } from './miden-logo-orange.svg';
import { ReactComponent as MidenLogoWhite } from './miden-logo-white.svg';
import { ReactComponent as MidenLogo } from './miden-logo.svg';
import { ReactComponent as More } from './more.svg';
import { ReactComponent as OnboardingLogo } from './onboarding-logo.svg';
import { ReactComponent as Pencil } from './pencil.svg';
import { ReactComponent as QrScan } from './qr-scan.svg';
import { ReactComponent as RadioFill } from './radio-fill.svg';
import { ReactComponent as RecallClock } from './recall-clock.svg';
import { ReactComponent as Refresh } from './refresh.svg';
import { ReactComponent as Rocket } from './rocket.svg';
import { ReactComponent as ScanFrame } from './scan-frame.svg';
import { ReactComponent as Search } from './search.svg';
import { ReactComponent as Settings2 } from './settings-2.svg';
import { ReactComponent as SettingsFill } from './settings-fill.svg';
import { ReactComponent as Settings } from './settings.svg';
import { ReactComponent as Share } from './share.svg';
import { ReactComponent as SmileSad } from './smile-sad.svg';
import { ReactComponent as Success } from './success.svg';
import { ReactComponent as TimeFill } from './time-fill.svg';
import { ReactComponent as Time } from './time.svg';
import { ReactComponent as Tokens } from './tokens.svg';
import { ReactComponent as UploadFile } from './upload-file.svg';
import { ReactComponent as UploadedFile } from './uploaded-file.svg';
import { ReactComponent as User } from './user.svg';
import { ReactComponent as Users } from './users.svg';
import { ReactComponent as WalletWelcome } from './wallet-welcome.svg';
import { ReactComponent as Wallet } from './wallet.svg';
import { ReactComponent as WarningFill } from './warning-fill.svg';
import { ReactComponent as Warning } from './warning.svg';

export enum IconName {
  AddCircle = 'add-circle',
  Add = 'add',
  AddressBook = 'address-book',
  Apps = 'apps',
  ArrowDown = 'arrow-down',
  ArrowLeft = 'arrow-left',
  ArrowRightDownFill = 'arrow-right-down-fill',
  ArrowRightDownFilledCircle = 'arrow-right-down-filled-circle',
  ArrowRightDown = 'arrow-right-down',
  ArrowRightUpFill = 'arrow-right-up-fill',
  ArrowRightUp = 'arrow-right-up',
  ArrowRight = 'arrow-right',
  ArrowUpDown = 'arrow-up-down',
  ArrowUp = 'arrow-up',
  Bell = 'bell',
  Calendar = 'calendar',
  Bin = 'bin',
  CheckboxCircleFill = 'checkbox-circle-fill',
  CheckboxCircle = 'checkbox-circle',
  CheckboxFill = 'checkbox-fill',
  Checkbox = 'checkbox',
  Checkmark = 'checkmark',
  ChevronDown = 'chevron-down',
  ChevronDownLucide = 'chevron-down-lucide',
  ChevronLeft = 'chevron-left',
  ChevronLeftLucide = 'chevron-left-lucide',
  ChevronRight = 'chevron-right',
  ChevronRightLucide = 'chevron-right-lucide',
  ChevronUp = 'chevron-up',
  Circle = 'circle',
  CloseCircleFill = 'close-circle-fill',
  CloseCircle = 'close-circle',
  Close = 'close',
  Code = 'code',
  Coins = 'coins',
  CoinsFill = 'coins-fill',
  ContactsBook = 'contacts-book',
  Convert = 'convert',
  Copy = 'copy',
  DelegateProving = 'delegate-proving',
  Download1 = 'download-1',
  Download = 'download',
  EmotionSad = 'emotion-sad',
  EyeOff = 'eye-off',
  Eye = 'eye',
  FaceId = 'face-id',
  Faucet = 'faucet',
  FaucetFill = 'faucet-fill',
  FileCopy = 'file-copy',
  FileSettings = 'file-settings',
  File = 'file',
  Frown = 'frown',
  Fullscreen = 'fullscreen',
  GlobalFill = 'global-fill',
  Globe = 'globe',
  Hammer = 'hammer',
  HomeFill = 'home-fill',
  Home = 'home',
  ImageFill = 'image-fill',
  ImagePrivate = 'image-private',
  ImagePublic = 'image-public',
  Image = 'image',
  IndeterminateCircle = 'indeterminate-circle',
  InformationFill = 'information-fill',
  Information = 'information',
  Key = 'key',
  LeoLogoAndName = 'leo-logo-and-name',
  LeoLogo = 'leo-logo',
  LeoLock = 'leo-lock',
  List = 'list',
  Loader = 'loader',
  Loading = 'loading',
  Lock = 'lock',
  More = 'more',
  Pencil = 'pencil',
  QrScan = 'qr-scan',
  RadioFill = 'radio-fill',
  RecallClock = 'recall-clock',
  Refresh = 'refresh',
  Rocket = 'rocket',
  ScanFrame = 'scan-frame',
  Search = 'search',
  Settings2 = 'settings-2',
  SettingsFill = 'settings-fill',
  Settings = 'settings',
  Share = 'share',
  SmileSad = 'smile-sad',
  Time = 'time',
  TimeFill = 'time-fill',
  User = 'user',
  Users = 'users',
  Wallet = 'wallet',
  WalletWelcome = 'wallet-welcome',
  WarningFill = 'warning-fill',
  Warning = 'warning',
  MidenLogo = 'miden-logo',
  MidenLogoWhite = 'miden-logo-white',
  MidenLogoOrange = 'miden-logo-orange',
  OnboardingLogo = 'onboarding-logo',
  UploadFile = 'upload-file',
  UploadedFile = 'uploaded-file',
  InProgress = 'in-progress',
  Failed = 'failed',
  Success = 'success',
  Tokens = 'tokens'
}

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | '3xl' | '4xl' | '5xl';

export interface IconProps extends React.SVGAttributes<SVGElement> {
  name: IconName;
  size?: IconSize;
}

const IconSwitch = (props: IconProps) => {
  switch (props.name) {
    case IconName.AddCircle:
      return <AddCircle {...props} />;
    case IconName.Add:
      return <Add {...props} />;
    case IconName.AddressBook:
      return <AddressBook {...props} />;
    case IconName.Apps:
      return <Apps {...props} />;
    case IconName.ArrowDown:
      return <ArrowDown {...props} />;
    case IconName.ArrowLeft:
      return <ArrowLeft {...props} />;
    case IconName.ArrowRightDownFill:
      return <ArrowRightDownFill {...props} />;
    case IconName.ArrowRightDown:
      return <ArrowRightDown {...props} />;
    case IconName.ArrowRightUpFill:
      return <ArrowRightUpFill {...props} />;
    case IconName.ArrowRightUp:
      return <ArrowRightUp {...props} />;
    case IconName.ArrowRight:
      return <ArrowRight {...props} />;
    case IconName.ArrowUpDown:
      return <ArrowUpDown {...props} />;
    case IconName.ArrowUp:
      return <ArrowUp {...props} />;
    case IconName.Bell:
      return <Bell {...props} />;
    case IconName.Calendar:
      return <Calendar {...props} />;
    case IconName.Bin:
      return <Bin {...props} />;
    case IconName.CheckboxCircleFill:
      return <CheckboxCircleFill {...props} />;
    case IconName.CheckboxCircle:
      return <CheckboxCircle {...props} />;
    case IconName.CheckboxFill:
      return <CheckboxFill {...props} />;
    case IconName.Checkbox:
      return <Checkbox {...props} />;
    case IconName.Checkmark:
      return <Checkmark {...props} />;
    case IconName.ChevronDown:
      return <ChevronDown {...props} />;
    case IconName.ChevronDownLucide:
      return <ChevronDownLucide {...props} />;
    case IconName.ChevronLeft:
      return <ChevronLeft {...props} />;
    case IconName.ChevronLeftLucide:
      return <ChevronLeftLucide {...props} />;
    case IconName.ChevronRight:
      return <ChevronRight {...props} />;
    case IconName.ChevronRightLucide:
      return <ChevronRightLucide {...props} />;
    case IconName.ChevronUp:
      return <ChevronUp {...props} />;
    case IconName.Circle:
      return <Circle {...props} />;
    case IconName.CloseCircleFill:
      return <CloseCircleFill {...props} />;
    case IconName.CloseCircle:
      return <CloseCircle {...props} />;
    case IconName.Close:
      return <Close {...props} />;
    case IconName.Code:
      return <Code {...props} />;
    case IconName.Coins:
      return <Coins {...props} />;
    case IconName.CoinsFill:
      return <CoinsFill {...props} />;
    case IconName.ContactsBook:
      return <ContactsBook {...props} />;
    case IconName.Convert:
      return <Convert {...props} />;
    case IconName.Copy:
      return <Copy {...props} />;
    case IconName.DelegateProving:
      return <DelegateProving {...props} />;
    case IconName.Download1:
      return <Download1 {...props} />;
    case IconName.Download:
      return <Download {...props} />;
    case IconName.EmotionSad:
      return <EmotionSad {...props} />;
    case IconName.EyeOff:
      return <EyeOff {...props} />;
    case IconName.Eye:
      return <Eye {...props} />;
    case IconName.FaceId:
      return <FaceId {...props} />;
    case IconName.Faucet:
      return <Faucet {...props} />;
    case IconName.FaucetFill:
      return <FaucetFill {...props} />;
    case IconName.FileCopy:
      return <FileCopy {...props} />;
    case IconName.FileSettings:
      return <FileSettings {...props} />;
    case IconName.File:
      return <File {...props} />;
    case IconName.Frown:
      return <Frown {...props} />;
    case IconName.Fullscreen:
      return <Fullscreen {...props} />;
    case IconName.GlobalFill:
      return <GlobalFill {...props} />;
    case IconName.Globe:
      return <Globe {...props} />;
    case IconName.Hammer:
      return <Hammer {...props} />;
    case IconName.HomeFill:
      return <HomeFill {...props} />;
    case IconName.Home:
      return <Home {...props} />;
    case IconName.ImageFill:
      return <ImageFill {...props} />;
    case IconName.ImagePrivate:
      return <ImagePrivate {...props} />;
    case IconName.ImagePublic:
      return <ImagePublic {...props} />;
    case IconName.Image:
      return <Image {...props} />;
    case IconName.IndeterminateCircle:
      return <IndeterminateCircle {...props} />;
    case IconName.InformationFill:
      return <InformationFill {...props} />;
    case IconName.Information:
      return <Information {...props} />;
    case IconName.Key:
      return <Key {...props} />;
    case IconName.LeoLogoAndName:
      return <LeoLogoAndName {...props} />;
    case IconName.LeoLogo:
      return <LeoLogo {...props} />;
    case IconName.LeoLock:
      return <LeoLock {...props} />;
    case IconName.List:
      return <List {...props} />;
    case IconName.Loader:
      return <Loader {...props} />;
    case IconName.Loading:
      return <Loading {...props} />;
    case IconName.Lock:
      return <Lock {...props} />;
    case IconName.More:
      return <More {...props} />;
    case IconName.Pencil:
      return <Pencil {...props} />;
    case IconName.QrScan:
      return <QrScan {...props} />;
    case IconName.RadioFill:
      return <RadioFill {...props} />;
    case IconName.RecallClock:
      return <RecallClock {...props} />;
    case IconName.Refresh:
      return <Refresh {...props} />;
    case IconName.Rocket:
      return <Rocket {...props} />;
    case IconName.ScanFrame:
      return <ScanFrame {...props} />;
    case IconName.Search:
      return <Search {...props} />;
    case IconName.Settings2:
      return <Settings2 {...props} />;
    case IconName.SettingsFill:
      return <SettingsFill {...props} />;
    case IconName.Settings:
      return <Settings {...props} />;
    case IconName.Share:
      return <Share {...props} />;
    case IconName.SmileSad:
      return <SmileSad {...props} />;
    case IconName.Time:
      return <Time {...props} />;
    case IconName.TimeFill:
      return <TimeFill {...props} />;
    case IconName.User:
      return <User {...props} />;
    case IconName.Users:
      return <Users {...props} />;
    case IconName.Wallet:
      return <Wallet {...props} />;
    case IconName.WalletWelcome:
      return <WalletWelcome {...props} />;
    case IconName.WarningFill:
      return <WarningFill {...props} />;
    case IconName.Warning:
      return <Warning {...props} />;
    case IconName.MidenLogo:
      return <MidenLogo {...props} />;
    case IconName.MidenLogoWhite:
      return <MidenLogoWhite {...props} />;
    case IconName.MidenLogoOrange:
      return <MidenLogoOrange {...props} />;
    case IconName.OnboardingLogo:
      return <OnboardingLogo {...props} />;
    case IconName.UploadFile:
      return <UploadFile {...props} />;
    case IconName.UploadedFile:
      return <UploadedFile {...props} />;
    case IconName.ArrowRightDownFilledCircle:
      return <ArrowRightDownFilledCircle {...props} />;
    case IconName.InProgress:
      return <InProgress {...props} />;
    case IconName.Failed:
      return <Failed {...props} />;
    case IconName.Success:
      return <Success {...props} />;
    case IconName.Tokens:
      return <Tokens {...props} />;
    default:
      return null;
  }
};

const iconClassNamePerSize = {
  xs: 'w-4 h-4',
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-12 h-12',
  xxl: 'w-16 h-16',
  '3xl': 'w-40 h-40',
  '4xl': 'w-49 h-49',
  '5xl': 'w-64 h-64'
};

export const Icon: React.FC<IconProps> = ({ className, size = 'md', ...props }) => {
  return <IconSwitch {...props} className={classNames(iconClassNamePerSize[size], className)} />;
};
