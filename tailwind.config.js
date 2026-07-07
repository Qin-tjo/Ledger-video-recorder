/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif']
      },
      colors: {
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
          soft: 'rgba(99,102,241,0.14)'
        },
        ink: {
          900: '#0b0c10',
          800: '#111318',
          700: '#171a21',
          600: '#1f232c',
          500: '#2a2f3a'
        }
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px'
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.2), 0 8px 30px rgba(0,0,0,0.35)',
        glow: '0 0 0 1px rgba(99,102,241,0.4), 0 8px 30px rgba(99,102,241,0.25)'
      },
      transitionTimingFunction: {
        premium: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }
    }
  },
  plugins: []
}
