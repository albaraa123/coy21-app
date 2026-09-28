import localFont from "next/font/local";

export const thmanyahSerif = localFont({
  src: [
    {
      path: "../fonts/thmanyah-serif-light.otf",
      weight: "300",
      style: "normal",
    },
    {
      path: "../fonts/thmanyah-serif-regular.otf",
      weight: "400",
      style: "normal",
    },
    {
      path: "../fonts/thmanyah-serif-medium.otf",
      weight: "500",
      style: "normal",
    },
    {
      path: "../fonts/thmanyah-serif-bold.otf",
      weight: "700",
      style: "normal",
    },
    {
      path: "../fonts/thmanyah-serif-black.otf",
      weight: "900",
      style: "normal",
    },
  ],
  variable: "--font-thmanyah-raw",
});
