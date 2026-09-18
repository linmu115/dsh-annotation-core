export function ReferenceIcon({ name }: { name: 'quote' | 'edit' | 'trash' | 'jump' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'quote' && <><path d="M9 10H5V6h6v7a5 5 0 0 1-5 5M19 10h-4V6h6v7a5 5 0 0 1-5 5" /></>}
    {name === 'edit' && <><path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5" /></>}
    {name === 'trash' && <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>}
    {name === 'jump' && <><path d="M14 3h7v7M21 3 10 14M10 3H4v17h17v-6" /></>}
  </svg>
}
