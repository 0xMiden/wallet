/**
 * Webpack configuration for desktop app (Tauri)
 *
 * This builds a standalone web app that runs in a Tauri webview.
 * Unlike the extension build, the backend runs in-process (no service worker).
 * Based on webpack.mobile.config.js with desktop-specific adjustments.
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
const OUTPUT_PATH = path.join(DIST_PATH, 'desktop');

const fileFormat = '[name].[hash][ext]';

/**
 * Desktop app configuration
 * Single entry point that includes backend in-process
 */
const desktopAppConfig = {
  mode: process.env.MODE_ENV || 'development',
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
    desktop: './src/desktop-app.tsx'
  },
  devServer: {
    hot: true,
    port: 3000
  },
  output: {
    pathinfo: false,
    path: OUTPUT_PATH,
    publicPath: '/',
    assetModuleFilename: `static/media/${fileFormat}`,
    chunkLoading: 'jsonp',
    chunkFormat: 'array-push',
    uniqueName: 'desktop-app'
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
      'process/browser': require.resolve('process/browser.js')
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
      // Flag to indicate desktop build
      MIDEN_PLATFORM: 'desktop'
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

    // HTML template for desktop
    new HtmlWebpackPlugin({
      template: path.join(PUBLIC_PATH, 'desktop.html'),
      filename: 'index.html',
      chunks: ['desktop'],
      inject: 'body'
    }),

    new WebpackBar({
      name: 'Miden Wallet Desktop',
      color: '#4A90D9'
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
            // Exclude manifest files (not needed for desktop)
            if (resourcePath.includes('manifest')) {
              return false;
            }
            // Exclude non-EN locales (for now)
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
 * Worker configuration for desktop
 * Web workers for heavy crypto operations (ZK proofs)
 */
const desktopWorkerConfig = {
  mode: process.env.MODE_ENV || 'development',
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
    uniqueName: 'desktop-workers'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.wasm'],
    alias: {
      lib: path.resolve(__dirname, 'src', 'lib'),
      shared: path.resolve(__dirname, 'src', 'shared'),
      screens: path.resolve(__dirname, 'src', 'screens'),
      'process/browser': require.resolve('process/browser.js')
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
      MIDEN_PLATFORM: 'desktop'
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
      name: 'Miden Wallet Desktop Workers',
      color: '#4A90D9'
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

module.exports = [desktopAppConfig];
