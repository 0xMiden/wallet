require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# This podspec is shipped for parity with Capacitor projects that still use
# CocoaPods. The Miden Wallet itself uses Swift Package Manager (see
# Package.swift) so this file is mostly informational.
Pod::Spec.new do |s|
  s.name = 'MidenDappBrowser'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/0xPolygonMiden/miden-wallet'
  s.author = 'Miden Wallet team'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
