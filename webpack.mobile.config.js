/**
 * Webpack configuration for mobile app (Capacitor)
 *
 * This builds a standalone web app that runs in a Capacitor webview.
 * Unlike the extension build, the backend runs in-process (no service worker).
 */

const CopyWebpackPlugin = require('copy-webpack-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const Dotenv = require('dotenv-webpack');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const path = require('path');
const webpack = require('webpack');
const WebpackBar = require('webpackbar');

const pkg = require('./package.json');

const { DISABLE_TS_CHECKER, MIDEN_USE_MOCK_CLIENT } = process.env;
const enableTsChecker = DISABLE_TS_CHECKER !== 'true';

const DIST_PATH = path.join(__dirname, 'dist');
const PUBLIC_PATH = path.join(__dirname, 'public');
const OUTPUT_PATH = path.join(DIST_PATH, 'mobile');

const fileFormat = '[name].[hash][ext]';

/**
 * Mobile app configuration
 * Single entry point that includes backend in-process
 */
const mobileAppConfig = {
  mode: process.env.MODE_ENV,
  devtool: process.env.MODE_ENV === 'production' ? false : 'source-map',
  cache: {
    type: 'filesystem',
    allowCollectingMemory: true
  },
  performance: {
    hints: false
  },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true,
    topLevelAwait: true
  },
  entry: {
    mobile: './src/mobile-app.tsx'
  },
  devServer: {
    hot: true
  },
  output: {
    pathinfo: false,
    path: OUTPUT_PATH,
    publicPath: '/',
    assetModuleFilename: `static/media/${fileFormat}`,
    chunkLoading: 'jsonp',
    chunkFormat: 'array-push',
    uniqueName: 'mobile-app'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.wasm'],
    alias: {
      lib: path.resolve(__dirname, 'src', 'lib'),
      app: path.resolve(__dirname, 'src', 'app'),
      shared: path.resolve(__dirname, 'src', 'shared'),
      stories: path.resolve(__dirname, 'src', 'stories'),
      components: path.resolve(__dirname, 'src', 'components'),
      screens: path.resolve(__dirname, 'src', 'screens'),
      utils: path.resolve(__dirname, 'src', 'utils'),
      'process/browser': require.resolve('process/browser.js'),
      'webextension-polyfill': path.resolve(__dirname, 'src', 'lib', 'webextension-polyfill-mock.js')
    },
    fallback: {
      url: false,
      os: false,
      path: false,
      crypto: false,
      http: false,
      https: false,
      buffer: require.resolve('buffer'),
      stream: require.resolve('stream-browserify'),
      assert: require.resolve('assert')
    }
  },
  optimization: {
    minimizer: [
      `...`,
      new CssMinimizerPlugin()
    ]
  },
  plugins: [
    new Dotenv(),
    new webpack.EnvironmentPlugin({
      VERSION: pkg.version,
      MIDEN_USE_MOCK_CLIENT: MIDEN_USE_MOCK_CLIENT || 'false',
      // Flag to indicate mobile build
      MIDEN_PLATFORM: 'mobile'
    }),

    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer']
    }),

    new webpack.ProvidePlugin({
      process: 'process/browser'
    }),

    new MiniCssExtractPlugin({
      filename: 'static/styles/[name].css',
      chunkFilename: 'static/styles/[name].chunk.css'
    }),

    ...(enableTsChecker ? [new ForkTsCheckerWebpackPlugin()] : []),

    // HTML template for mobile
    new HtmlWebpackPlugin({
      template: path.join(PUBLIC_PATH, 'mobile.html'),
      filename: 'index.html',
      chunks: ['mobile'],
      inject: 'body'
    }),

    new WebpackBar({
      name: 'Miden Wallet Mobile',
      color: '#FF5500'
    }),

    // Copy public assets (icons, locales, etc.)
    new CopyWebpackPlugin({
      patterns: [
        {
          from: PUBLIC_PATH,
          to: OUTPUT_PATH,
          filter: resourcePath => {
            // Exclude HTML files (we use HtmlWebpackPlugin)
            if (resourcePath.endsWith('.html')) {
              return false;
            }
            // Exclude manifest files (not needed for mobile)
            if (resourcePath.includes('manifest')) {
              return false;
            }
            // Exclude non-EN locales
            const localesDirectory = path.join(PUBLIC_PATH, '_locales');
            if (resourcePath.startsWith(localesDirectory + path.sep)) {
              const enLocaleDirectory = path.join(localesDirectory, 'en');
              return resourcePath.startsWith(enLocaleDirectory + path.sep);
            }
            return true;
          }
        }
      ]
    })
  ],
  module: {
    rules: [
      {
        test: /\.wasm$/i,
        type: 'asset/resource',
        generator: {
          filename: `static/wasm/[name].[hash][ext]`
        }
      },
      {
        test: /\.(woff|woff2)$/i,
        type: 'asset/resource',
        generator: {
          filename: `static/fonts/${fileFormat}`
        }
      },
      {
        test: /\.(png|jpg|jpeg|gif)$/i,
        type: 'asset/resource',
        generator: {
          filename: `static/media/${fileFormat}`
        }
      },
      {
        test: /\.module\.css$/i,
        sideEffects: true,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              modules: {
                localIdentName: '[path][name]__[local]--[hash:base64:5]'
              }
            }
          },
          'postcss-loader'
        ]
      },
      {
        test: /\.css$/i,
        exclude: /\.module\.css$/i,
        sideEffects: true,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1
            }
          },
          'postcss-loader'
        ]
      },
      {
        test: /\.svg$/i,
        issuer: /\.tsx?$/,
        use: [
          {
            loader: '@svgr/webpack',
            options: {
              prettier: false,
              svgo: false,
              svgoConfig: {
                plugins: [{ removeViewBox: false }]
              },
              titleProp: true,
              ref: true
            }
          },
          {
            loader: 'file-loader',
            options: {
              name: 'static/media/[name].[hash].[ext]'
            }
          }
        ]
      },
      {
        test: /\.m?js$/i,
        exclude: /node_modules/,
        type: 'javascript/auto'
      },
      {
        test: /\.tsx?$/i,
        exclude: /node_modules/,
        use: 'swc-loader'
      }
    ]
  }
};

/**
 * Worker configuration for mobile
 * Web workers for heavy crypto operations (ZK proofs)
 */
const mobileWorkerConfig = {
  mode: process.env.MODE_ENV,
  devtool: process.env.MODE_ENV === 'development' ? 'inline-source-map' : false,
  cache: {
    type: 'filesystem',
    allowCollectingMemory: true
  },
  performance: {
    hints: false
  },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true,
    topLevelAwait: true
  },
  target: 'webworker',
  entry: {
    consumeNoteId: './src/workers/consumeNoteId.ts',
    sendTransaction: './src/workers/sendTransaction.ts',
    submitTransaction: './src/workers/submitTransaction.ts'
  },
  output: {
    pathinfo: false,
    path: OUTPUT_PATH,
    publicPath: '',
    assetModuleFilename: `static/media/${fileFormat}`,
    chunkLoading: 'import-scripts',
    chunkFormat: 'array-push',
    chunkFilename: 'w.[id].[contenthash].js',
    uniqueName: 'mobile-workers'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.wasm'],
    alias: {
      lib: path.resolve(__dirname, 'src', 'lib'),
      shared: path.resolve(__dirname, 'src', 'shared'),
      screens: path.resolve(__dirname, 'src', 'screens'),
      'process/browser': require.resolve('process/browser.js'),
      'webextension-polyfill': path.resolve(__dirname, 'src', 'lib', 'webextension-polyfill-mock.js')
    },
    fallback: {
      url: false,
      os: false,
      path: false,
      crypto: false,
      http: false,
      https: false,
      buffer: require.resolve('buffer'),
      stream: require.resolve('stream-browserify'),
      assert: require.resolve('assert')
    }
  },
  plugins: [
    new Dotenv(),
    new webpack.EnvironmentPlugin({
      VERSION: pkg.version,
      MIDEN_PLATFORM: 'mobile'
    }),

    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer']
    }),

    new webpack.ProvidePlugin({
      process: 'process/browser'
    }),

    new MiniCssExtractPlugin({
      filename: 'static/styles/[name].css',
      chunkFilename: 'static/styles/[name].chunk.css'
    }),

    new WebpackBar({
      name: 'Miden Wallet Mobile Workers',
      color: '#FF5500'
    })
  ],
  module: {
    rules: [
      {
        test: /\.wasm$/i,
        type: 'asset/resource',
        generator: {
          filename: `static/wasm/[name].[hash][ext]`
        }
      },
      {
        test: /\.m?js$/i,
        exclude: /node_modules/,
        type: 'javascript/auto'
      },
      {
        test: /\.tsx?$/i,
        exclude: /node_modules/,
        use: 'swc-loader'
      }
    ]
  }
};

module.exports = [mobileAppConfig];
