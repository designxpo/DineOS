import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter, Noto_Sans_Devanagari } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// next/font downloads these at build time and serves them from our own origin.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', weight: ['500', '600', '700'] });
const devanagari = Noto_Sans_Devanagari({ subsets: ['devanagari'], variable: '--font-devanagari', display: 'swap', weight: ['400', '500', '600', '700'] });

export const metadata: Metadata = {
  title: { default: 'DineOS', template: '%s · DineOS' },
  description: 'QR ordering, POS, kitchen display and owner portal for restaurants and cafes',
  applicationName: 'DineOS',
  icons: { icon: '/icon.svg' },
  appleWebApp: { capable: true, title: 'DineOS', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets bottom bars pad for the iPhone home indicator (env(safe-area-inset-bottom)).
  viewportFit: 'cover',
  themeColor: '#a8441a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${devanagari.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
