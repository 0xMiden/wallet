export enum ReceiveStep {
  Default = 'Default',
  // Outer Receive navigator: the whole bridge-deposit flow as a single card.
  ShowBridgePage = 'ShowBridgePage',
  // Inner bridge navigator: amount entry → route selection → review.
  ShowBridgePageTakeAmount = 'ShowBridgePageTakeAmount',
  ShowBridgePageRoute = 'ShowBridgePageRoute',
  ShowBridgePageReview = 'ShowBridgePageReview'
}
