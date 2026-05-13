require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Compatibility podspec — the wallet uses Swift Package Manager (Package.swift)
# but Capacitor projects on CocoaPods need this file.
Pod::Spec.new do |s|
  s.name = 'MidenNativeProver'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.homepage = 'https://github.com/0xPolygonMiden/miden-wallet'
  s.author = 'Miden Wallet team'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.{swift}'
  s.ios.vendored_frameworks = 'ios/MidenMobileProver.xcframework'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
