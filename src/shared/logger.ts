import manifestJson from '../../public/manifest.json';

export interface ILog {
  level: string;
  message: string;
  meta: object;
}

class ServerLogger {
  private censorKeys(input: string): string {
    const privateKeyPattern = /APrivateKey[\w\d]{48}/g;
    const privateKeyreplacementText = 'APrivateKey****';
    const viewKeyPattern = /AViewKey[\w\d]{45}/g;
    const viewKeyreplacementText = 'AViewKey****';
    return input.replace(privateKeyPattern, privateKeyreplacementText).replace(viewKeyPattern, viewKeyreplacementText);
  }

  async info(message: string, meta?: any) {
    console.info(message);
    await this.sendLog('info', message, meta);
  }

  async warning(message: string, meta?: any) {
    console.warn(message);
    await this.sendLog('warn', message, meta);
  }

  async error(message: string, meta?: any) {
    console.error(message, meta);
    await this.sendLog('error', message, meta);
  }

  private async sendLog(level: string, message: string, meta: any = {}) {
    if (process.env.MODE_ENV !== 'production') {
      return;
    }
    var analytics = localStorage.getItem('analytics');
    var analyticsJson = JSON.parse(analytics || '{}');

    if (analytics && !analyticsJson.enabled === true) {
      return;
    }
    meta = {
      walletVersion: manifestJson.version,
      ...(meta || {})
    };
    var censoredMeta = this.censorKeys(JSON.stringify(meta));
    const log: ILog = {
      level: level,
      message: this.censorKeys(message),
      meta: JSON.parse(censoredMeta)
    };

    await this.sendLogToServer(log);
  }

  private async sendLogToServer(_log: ILog) {}
}

const envLogger = new ServerLogger();
export const logger = envLogger;
