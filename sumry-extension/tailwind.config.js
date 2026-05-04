/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./popup/**/*.{html,js}", "./styles/**/*.css"],
  theme: {
    extend: {
      colors: {
        ember: "#F2921D",
        flame: "#F24F13",
        dusk: "#46334F"
      },
      transitionTimingFunction: {
        sumly: "ease-out"
      },
      transitionDuration: {
        200: "200ms"
      },
      borderRadius: {
        DEFAULT: "8px"
      }
    }
  },
  plugins: []
};
