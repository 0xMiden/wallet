import {defineConfig} from 'vite';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import {resolve} from 'node:path';
import extension from '../../../vite.extension.config';
const root=resolve(import.meta.dirname,'../../..'), fixture=resolve(import.meta.dirname,'fixture.tsx');
const mocked=['lib/miden/activity','lib/miden/balance-snapshot','lib/miden/front/assets','lib/miden/front/balance','lib/miden/front/ready','lib/miden/sdk/helpers','lib/miden/transaction/initiate','lib/miden/sdk/pswap-order-note','lib/miden-chain/effective-endpoints','lib/miden-chain/native-asset','lib/platform','lib/remote-config/runtime','lib/settings/helpers','lib/store','lib/woozie','lib/mobile/haptics','lib/mobile/useHideNavbarWhileOpen','lib/mobile/useCloseOnBack','lib/i18n/core'];
export default defineConfig({root:import.meta.dirname,publicDir:resolve(root,'public'),plugins:[tailwind(),react(),...extension.plugins!.filter(p=>p&&'name'in p&&p.name==='svg-to-react')],resolve:{dedupe:['react','react-dom'],alias:[...mocked.map(p=>({find:new RegExp('^'+p+'$'),replacement:fixture})),{find:/^\.\/arcade\/useGcPurchaseQuote$/,replacement:fixture},...['app','components','lib','utils','screens','shared'].map(p=>({find:new RegExp('^'+p+'/'),replacement:resolve(root,'src',p)+'/'}))]},define:{'process.env':{},global:'globalThis'},build:{outDir:resolve(root,'visual-proof-bundle'),emptyOutDir:true},preview:{host:'127.0.0.1',port:5192,strictPort:true}});
