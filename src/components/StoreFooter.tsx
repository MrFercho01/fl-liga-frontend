import { useEffect, useRef, useState } from 'react'

export const StoreFooter = () => {
  const year = new Date().getFullYear()
  const footerRef = useRef<HTMLElement | null>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const element = footerRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.15 },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <footer
      ref={footerRef}
      className={`mt-10 border-t border-white/20 bg-slate-950/70 backdrop-blur-sm transition-all duration-700 ${
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
      }`}
    >
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 md:grid-cols-[1.2fr_1fr] md:px-8">
        <div className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-primary-300/40 hover:bg-white/10 hover:shadow-[0_10px_30px_rgba(56,189,248,0.15)]">
          <img
            src="/logo.png"
            alt="FL"
            className="h-16 w-16 rounded-full border border-white/20 bg-white object-contain p-1 transition duration-300 group-hover:scale-105 group-hover:shadow-[0_0_25px_rgba(56,189,248,0.35)]"
          />
          <div>
            <p className="text-lg font-bold text-white">Fernando Lara Soft</p>
            <p className="text-sm text-slate-300">Soluciones digitales innovadoras para tu negocio</p>
            <p className="mt-1 text-sm font-semibold text-primary-200">
              Desarrollado por <span className="text-primary-300">Fernando Lara Morán</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">© {year} Todos los derechos reservados</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/15 bg-white/5 p-4 transition duration-300 hover:border-primary-300/40 hover:bg-white/10 hover:shadow-[0_10px_30px_rgba(56,189,248,0.12)]">
          <p className="mb-2 text-sm font-semibold text-white">Contacto directo</p>
          <div className="space-y-1 text-sm text-slate-200">
            <a
              href="https://wa.me/593993385551"
              target="_blank"
              rel="noreferrer"
              className="block transition hover:translate-x-0.5 hover:text-primary-300"
            >
              WhatsApp: +593 993385551
            </a>
            <a href="tel:+593993385551" className="block transition hover:translate-x-0.5 hover:text-primary-300">
              Celular: +593 993385551
            </a>
            <a
              href="mailto:fernando.lara.moran@gmail.com"
              className="block break-all transition hover:translate-x-0.5 hover:text-primary-300"
            >
              fernando.lara.moran@gmail.com
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
