import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DineOS',
    short_name: 'DineOS',
    description: 'Restaurant ordering, kitchen and billing',
    start_url: '/app',
    display: 'standalone',
    background_color: '#fbf9f6',
    theme_color: '#a8441a',
    orientation: 'any',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
