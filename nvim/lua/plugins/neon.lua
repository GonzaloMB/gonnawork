return {
  {
    "folke/tokyonight.nvim",
    opts = {
      style = "night",
      transparent = true,
      styles = { sidebars = "transparent", floats = "transparent" },
      on_colors = function(c)
        c.bg = "#080912"
        c.bg_dark = "#080912"
        c.fg = "#E6F7FF"
        c.blue = "#497BFF"
        c.cyan = "#00F5FF"
        c.blue1 = "#00F5FF"
        c.blue2 = "#00F5FF"
        c.magenta = "#FF00D4"
        c.purple = "#FF00D4"
        c.green = "#39FF88"
        c.yellow = "#FFE600"
        c.orange = "#FF9E00"
        c.red = "#FF285B"
        c.comment = "#7887A8"
        c.border = "#00F5FF"
      end,
      on_highlights = function(hl, c)
        hl.CursorLine = { bg = "#14162A" }
        hl.LineNr = { fg = "#67729B" }
        hl.CursorLineNr = { fg = c.cyan, bold = true }
        hl.Visual = { bg = "#6D1AA3" }
        hl.FloatBorder = { fg = c.cyan, bg = "NONE" }
        hl.WinSeparator = { fg = c.magenta, bg = "NONE" }
        hl.SnacksDashboardHeader = { fg = c.cyan, bold = true }
        hl.SnacksDashboardKey = { fg = c.magenta, bold = true }
        hl.SnacksPickerPathIgnored = { fg = "#FF00D4", bold = true }
        hl.SnacksPickerPathHidden = { fg = "#00F5FF", bold = true }
      end,
    },
  },
  { "LazyVim/LazyVim", opts = { colorscheme = "tokyonight" } },
  {
    "nvim-lualine/lualine.nvim",
    opts = {
      options = {
        theme = {
          normal = { a = { fg = "#080912", bg = "#00F5FF", gui = "bold" } },
          insert = { a = { fg = "#080912", bg = "#FF00D4", gui = "bold" } },
          visual = { a = { fg = "#080912", bg = "#FFE600", gui = "bold" } },
          replace = { a = { fg = "#080912", bg = "#FF285B", gui = "bold" } },
          command = { a = { fg = "#080912", bg = "#39FF88", gui = "bold" } },
          inactive = {
            a = { fg = "#67729B", bg = "NONE" },
            b = { fg = "#67729B", bg = "NONE" },
            c = { fg = "#67729B", bg = "NONE" },
          },
        },
      },
    },
    config = function(_, opts)
      for _, mode in pairs(opts.options.theme) do
        mode.b = mode.b or { fg = "#FF00D4", bg = "NONE" }
        mode.c = mode.c or { fg = "#E6F7FF", bg = "NONE" }
      end
      require("lualine").setup(opts)
    end,
  },
  {
    "folke/snacks.nvim",
    opts = {
      explorer = {
        hidden = true,
        ignored = true,
        include = { ".env", ".env.*" },
        exclude = { "node_modules", ".git", ".next", "dist", "build", "vendor" },
      },
      picker = {
        sources = {
          explorer = {
            hidden = true,
            ignored = true,
            exclude = { "node_modules", ".git", ".next", "dist", "build", "vendor" },
          },
          files = {
            hidden = true,
          },
        },
      },
      dashboard = {
        preset = {
          header = "\n   gonnawork\n\n   N E O V I M\n",
        },
      },
    },
  },
}
