'use client'

interface IntroProps {
  onStart: () => void
}

export default function Intro({ onStart }: IntroProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Where does downtown start?</h1>
      <p style={{ maxWidth: 480, lineHeight: 1.6, marginBottom: 40, opacity: 0.8 }}>
        Ask ten New Yorkers where downtown Manhattan ends and uptown begins,
        and you&apos;ll get ten different answers. Houston Street? 14th? Canal?
        Scroll the map to cast your vote.
      </p>
      <button onClick={onStart} style={{ padding: '12px 32px', fontSize: 18, cursor: 'pointer' }}>
        Let&apos;s settle this
      </button>
    </div>
  )
}
