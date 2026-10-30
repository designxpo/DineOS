import type { Metadata, Viewport } from 'next';
import { Fraunces, Manrope, Noto_Sans_Devanagari } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// next/font downloads these at build time and serves them from our own origin.
// Manrope is Mezvaan's type; Fraunces is kept for restaurants that choose classic headings.
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', weight: ['500', '600', '700'] });
const devanagari = Noto_Sans_Devanagari({ subsets: ['devanagari'], variable: '--font-devanagari', display: 'swap', weight: ['400', '500', '600', '700'] });

export const metadata: Metadata = {
  title: { default: 'Mezvaan', template: '%s · Mezvaan' },
  description: 'Restaurant operations, together: QR ordering, POS, kitchen display and owner portal for restaurants and cafés',
  applicationName: 'Mezvaan',
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' }], apple: '/brand/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Mezvaan', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets bottom bars pad for the iPhone home indicator (env(safe-area-inset-bottom)).
  viewportFit: 'cover',
  themeColor: '#241c36',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${fraunces.variable} ${devanagari.variable}`}>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
