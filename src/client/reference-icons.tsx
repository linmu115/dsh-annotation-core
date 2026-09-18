export function ReferenceIcon({ name }: { name: 'quote' | 'edit' | 'trash' | 'jump' | 'unlink' | 'check' | 'close' | 'plus' | 'retry' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'quote' && <><path d="M9 10H5V6h6v7a5 5 0 0 1-5 5M19 10h-4V6h6v7a5 5 0 0 1-5 5" /></>}
    {name === 'edit' && <><path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5" /></>}
    {name === 'trash' && <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>}
    {name === 'jump' && <><path d="M7 17V7h10M7 7l10 10" /></>}
    {name === 'unlink' && <path d="m18.84 12.25 1.42-1.42a5 5 0 0 0-7.07-7.07l-1.42 1.42M5.16 11.75l-1.42 1.42a5 5 0 0 0 7.07 7.07l1.42-1.42M8 2v3M2 8h3M16 19v3M19 16h3" />}
    {name === 'plus' && <path d="M12 5v14M5 12h14" />}
    {name === 'retry' && <path d="M20 7v5h-5M20 12a8 8 0 1 0-2 5" />}
    {name === 'check' && <path d="m5 12 4 4L19 6" />}
    {name === 'close' && <path d="m6 6 12 12M6 18 18 6" />}
  </svg>
}
