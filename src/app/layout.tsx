import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

// Design-system fonts (the ported tokens reference these via CSS variables).
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-fraunces',
  display: 'swap',
})
const geist = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-geist',
  display: 'swap',
})
const geistMono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

// Absolute base for OG/canonical URLs. Set NEXT_PUBLIC_SITE_URL to the deployed
// origin (e.g. https://you.github.io/groundswell) so shared links unfurl correctly.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://groundswell.local'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Josh Gonzales — research tools I build and ship',
    template: '%s — Groundswell',
  },
  description:
    'Research tools I build and ship — real GitHub traction, led by an honest aggregate.',
  openGraph: {
    title: 'Josh Gonzales — research tools I build and ship',
    description:
      'Real GitHub traction for the research tools I build — led by an honest aggregate, not a vanity badge.',
    siteName: 'Groundswell',
    type: 'website',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Josh Gonzales — research tools I build and ship',
    description:
      'Real GitHub traction for the research tools I build — led by an honest aggregate.',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${geist.variable} ${geistMono.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
