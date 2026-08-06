import React from 'react';

import classNames from 'clsx';

import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import { ReactComponent as LeoLogo } from '../leo-logo-blue.svg';
import { ReactComponent as Activity } from './activity.svg';
import { ReactComponent as AddCircle } from './add-circle.svg';
import { ReactComponent as Add } from './add.svg';
import { ReactComponent as AddressBook } from './address-book.svg';
import { ReactComponent as Apps } from './apps.svg';
import { ReactComponent as ArrowDown } from './arrow-down.svg';
import { ReactComponent as ArrowLeft } from './arrow-left.svg';
import { ReactComponent as ArrowRightDownFill } from './arrow-right-down-fill.svg';
import { ReactComponent as ArrowRightUpFill } from './arrow-right-up-fill.svg';
import { ReactComponent as ArrowRightUp } from './arrow-right-up.svg';
import { ReactComponent as ArrowRight } from './arrow-right.svg';
import { ReactComponent as ArrowUpDown } from './arrow-up-down.svg';
import { ReactComponent as ArrowUp } from './arrow-up.svg';
import { ReactComponent as BackArrow } from './back-arrow.svg';
import { ReactComponent as Backspace } from './backspace.svg';
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
import { ReactComponent as Coins } from './coins.svg';
import { ReactComponent as ContactsBook } from './contacts-book.svg';
import { ReactComponent as Convert } from './convert.svg';
import { ReactComponent as Copy } from './copy.svg';
import { ReactComponent as CrossChain } from './cross-chain.svg';
import { ReactComponent as Download } from './download.svg';
import { ReactComponent as Earn } from './earn.svg';
import { ReactComponent as Explore } from './explore.svg';
import { ReactComponent as EyeOff } from './eye-off.svg';
import { ReactComponent as Eye } from './eye.svg';
import { ReactComponent as FaceId } from './face-id.svg';
import { ReactComponent as Failed } from './failed.svg';
import { ReactComponent as Faucet } from './faucet.svg';
import { ReactComponent as FileCopy } from './file-copy.svg';
import { ReactComponent as FileSettings } from './file-settings.svg';
import { ReactComponent as File } from './file.svg';
import { ReactComponent as Frown } from './frown.svg';
import { ReactComponent as Fullscreen } from './fullscreen.svg';
import { ReactComponent as Globe } from './globe.svg';
import { ReactComponent as Hammer } from './hammer.svg';
import { ReactComponent as Home } from './home-new.svg';
import { ReactComponent as Hourglass } from './hourglass.svg';
import { ReactComponent as ImagePrivate } from './image-private.svg';
import { ReactComponent as ImagePublic } from './image-public.svg';
import { ReactComponent as Image } from './image.svg';
import { ReactComponent as InProgress } from './in-progress.svg';
import { ReactComponent as IndeterminateCircle } from './indeterminate-circle.svg';
import { ReactComponent as InformationFill } from './information-fill.svg';
import { ReactComponent as Information } from './information.svg';
import { ReactComponent as Key } from './key.svg';
import { ReactComponent as List } from './list.svg';
import { ReactComponent as Loader } from './loader.svg';
import { ReactComponent as Lock } from './lock.svg';
import { ReactComponent as MidenLogoWhite } from './miden-logo-white.svg';
import { ReactComponent as MidenLogo } from './miden-logo.svg';
import { ReactComponent as More } from './more.svg';
import { ReactComponent as PendingNotes } from './pending-notes.svg';
import { ReactComponent as QrScan } from './qr-scan.svg';
import { ReactComponent as Receive } from './receive-new.svg';
import { ReactComponent as Refresh } from './refresh.svg';
import { ReactComponent as Rocket } from './rocket.svg';
import { ReactComponent as ScanFrame } from './scan-frame.svg';
import { ReactComponent as Search } from './search.svg';
import { ReactComponent as Send } from './send-new.svg';
import { ReactComponent as Settings2 } from './settings-2.svg';
import { ReactComponent as SettingsNew } from './settings-new.svg';
import { ReactComponent as Settings } from './settings.svg';
import { ReactComponent as Share } from './share.svg';
import { ReactComponent as SuccessDevnet } from './success-devnet.svg';
import { ReactComponent as Success } from './success.svg';
import { ReactComponent as Switch } from './switch.svg';
import { ReactComponent as Time } from './time.svg';
import { ReactComponent as Tokens } from './tokens.svg';
import { ReactComponent as UploadFile } from './upload-file.svg';
import { ReactComponent as UploadedFile } from './uploaded-file.svg';
import { ReactComponent as User } from './user.svg';
import { ReactComponent as Users } from './users.svg';
import { ReactComponent as Wallet } from './wallet.svg';
import { ReactComponent as WarningFill } from './warning-fill.svg';
import { ReactComponent as Warning } from './warning.svg';

const isDevnet = DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET;

export enum IconName {
  Activity = 'activity',
  AddCircle = 'add-circle',
  Add = 'add',
  AddressBook = 'address-book',
  Apps = 'apps',
  ArrowDown = 'arrow-down',
  ArrowLeft = 'arrow-left',
  ArrowRightDownFill = 'arrow-right-down-fill',
  ArrowRightUpFill = 'arrow-right-up-fill',
  ArrowRightUp = 'arrow-right-up',
  ArrowRight = 'arrow-right',
  ArrowUpDown = 'arrow-up-down',
  ArrowUp = 'arrow-up',
  BackArrow = 'back-arrow',
  Backspace = 'backspace',
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
  ContactsBook = 'contacts-book',
  Convert = 'convert',
  Copy = 'copy',
  CrossChain = 'cross-chain',
  Download = 'download',
  Earn = 'earn',
  Explore = 'explore',
  EyeOff = 'eye-off',
  Eye = 'eye',
  FaceId = 'face-id',
  Faucet = 'faucet',
  FileCopy = 'file-copy',
  FileSettings = 'file-settings',
  File = 'file',
  Frown = 'frown',
  Fullscreen = 'fullscreen',
  Globe = 'globe',
  Hammer = 'hammer',
  Home = 'home',
  Hourglass = 'hourglass',
  ImagePrivate = 'image-private',
  ImagePublic = 'image-public',
  Image = 'image',
  IndeterminateCircle = 'indeterminate-circle',
  InformationFill = 'information-fill',
  Information = 'information',
  Key = 'key',
  LeoLogo = 'leo-logo',
  List = 'list',
  Loader = 'loader',
  Lock = 'lock',
  More = 'more',
  PendingNotes = 'pending-notes',
  QrScan = 'qr-scan',
  Refresh = 'refresh',
  Rocket = 'rocket',
  ScanFrame = 'scan-frame',
  Search = 'search',
  Send = 'send',
  Settings2 = 'settings-2',
  Settings = 'settings',
  SettingsNew = 'settings-new',
  Share = 'share',
  Switch = 'switch',
  Time = 'time',
  User = 'user',
  Users = 'users',
  Wallet = 'wallet',
  WarningFill = 'warning-fill',
  Warning = 'warning',
  MidenLogo = 'miden-logo',
  MidenLogoWhite = 'miden-logo-white',
  UploadFile = 'upload-file',
  UploadedFile = 'uploaded-file',
  InProgress = 'in-progress',
  Failed = 'failed',
  Success = 'success',
  Tokens = 'tokens',
  Receive = 'receive'
}

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | '3xl' | '4xl' | '5xl';

export interface IconProps extends React.SVGAttributes<SVGElement> {
  name: IconName;
  size?: IconSize;
}

const IconSwitch = (props: IconProps) => {
  switch (props.name) {
    case IconName.Activity:
      return <Activity {...props} />;
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
    case IconName.BackArrow:
      return <BackArrow {...props} />;
    case IconName.Backspace:
      return <Backspace {...props} />;
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
    case IconName.ContactsBook:
      return <ContactsBook {...props} />;
    case IconName.Convert:
      return <Convert {...props} />;
    case IconName.Copy:
      return <Copy {...props} />;
    case IconName.CrossChain:
      return <CrossChain {...props} />;
    case IconName.Download:
      return <Download {...props} />;
    case IconName.Earn:
      return <Earn {...props} />;
    case IconName.Explore:
      return <Explore {...props} />;
    case IconName.EyeOff:
      return <EyeOff {...props} />;
    case IconName.Eye:
      return <Eye {...props} />;
    case IconName.FaceId:
      return <FaceId {...props} />;
    case IconName.Faucet:
      return <Faucet {...props} />;
    case IconName.FileCopy:
      return <FileCopy {...props} />;
    case IconName.PendingNotes:
      return <PendingNotes {...props} />;
    case IconName.FileSettings:
      return <FileSettings {...props} />;
    case IconName.File:
      return <File {...props} />;
    case IconName.Frown:
      return <Frown {...props} />;
    case IconName.Fullscreen:
      return <Fullscreen {...props} />;
    case IconName.Globe:
      return <Globe {...props} />;
    case IconName.Hammer:
      return <Hammer {...props} />;
    case IconName.Home:
      return <Home {...props} />;
    case IconName.Hourglass:
      return <Hourglass {...props} />;
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
    case IconName.LeoLogo:
      return <LeoLogo {...props} />;
    case IconName.List:
      return <List {...props} />;
    case IconName.Loader:
      return <Loader {...props} />;
    case IconName.Lock:
      return <Lock {...props} />;
    case IconName.More:
      return <More {...props} />;
    case IconName.QrScan:
      return <QrScan {...props} />;
    case IconName.Refresh:
      return <Refresh {...props} />;
    case IconName.Rocket:
      return <Rocket {...props} />;
    case IconName.ScanFrame:
      return <ScanFrame {...props} />;
    case IconName.Search:
      return <Search {...props} />;
    case IconName.Send:
      return <Send {...props} />;
    case IconName.Settings2:
      return <Settings2 {...props} />;
    case IconName.Settings:
      return <Settings {...props} />;
    case IconName.SettingsNew:
      return <SettingsNew {...props} />;
    case IconName.Share:
      return <Share {...props} />;
    case IconName.Switch:
      return <Switch {...props} />;
    case IconName.Time:
      return <Time {...props} />;
    case IconName.User:
      return <User {...props} />;
    case IconName.Users:
      return <Users {...props} />;
    case IconName.Wallet:
      return <Wallet {...props} />;
    case IconName.WarningFill:
      return <WarningFill {...props} />;
    case IconName.Warning:
      return <Warning {...props} />;
    case IconName.MidenLogo:
      return <MidenLogo {...props} />;
    case IconName.MidenLogoWhite:
      return <MidenLogoWhite {...props} />;
    case IconName.UploadFile:
      return <UploadFile {...props} />;
    case IconName.UploadedFile:
      return <UploadedFile {...props} />;
    case IconName.InProgress:
      return <InProgress {...props} />;
    case IconName.Failed:
      return <Failed {...props} />;
    case IconName.Success:
      return isDevnet ? <SuccessDevnet {...props} /> : <Success {...props} />;
    case IconName.Tokens:
      return <Tokens {...props} />;
    case IconName.Receive:
      return <Receive {...props} />;
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
