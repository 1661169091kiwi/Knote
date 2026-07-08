/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{vue,js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {},
    },
    plugins: [
        require('@tailwindcss/typography'),
        require('daisyui'),
    ],
    daisyui: {
        themes: [
            "light",
            "dark",
            "cupcake",
            {
                retro: {
                    ...require("daisyui/src/theming/themes")["retro"],
                    "primary": "#d99a5e",
                    "secondary": "#a88b6c",
                    "accent": "#d4c8be",
                    "neutral": "#5c5042",
                    "base-100": "#f4f1ea",
                    "base-200": "#e9e5db",
                    "base-300": "#dcd7cc",
                    "base-content": "#4b3c2a",
                    "info": "#7CA5B8",
                    "success": "#86A56C",
                    "warning": "#D1A45B",
                    "error": "#C26D6D",
                },
            },
        ],
    },
}
