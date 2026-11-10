/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1020",
        panel: "#141a2e",
        accent: "#2563eb",
        accent2: "#7c3aed",
      },
    },
  },
  plugins: [],
};
