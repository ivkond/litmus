import type { Metadata } from 'next';
import { JetBrains_Mono, DM_Sans } from 'next/font/google';
import { NavBar } from '@/components/nav-bar';
import './globals.css';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Litmus — Agent Benchmarking',
  description: 'Compare LLM coding agents across models and scenarios',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${jetbrainsMono.variable} ${dmSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Blocking script prevents FODT (flash of dark theme) for light-system users.
            Reads saved preference from localStorage, falls back to prefers-color-scheme.
            Content is a static string literal — no user input, no XSS vector. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('litmus-theme')||'system';var r=t==='system'?window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light':t;document.documentElement.setAttribute('data-theme',r)}catch(e){document.documentElement.setAttribute('data-theme','dark')}})()`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <div className="max-w-[1440px] mx-auto px-6 py-4">
          <NavBar />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
