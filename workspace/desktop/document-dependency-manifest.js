'use strict';

// Every automatic asset is pinned to an immutable version and SHA-256. This
// file is intentionally code-owned: remote metadata can never expand the set
// of programs or fonts CMOE Workspace is allowed to install.
module.exports = Object.freeze({
  manifestVersion: 1,
  applications: Object.freeze({
    officePowerPoint: Object.freeze({
      officialInstallerUrl: 'https://support.microsoft.com/ko-kr/office/download-install-or-reinstall-microsoft-365-or-office-2024-on-a-pc-or-mac'
    }),
    officeWord: Object.freeze({
      officialInstallerUrl: 'https://support.microsoft.com/ko-kr/office/download-install-or-reinstall-microsoft-365-or-office-2024-on-a-pc-or-mac'
    }),
    officeExcel: Object.freeze({
      officialInstallerUrl: 'https://support.microsoft.com/ko-kr/office/download-install-or-reinstall-microsoft-365-or-office-2024-on-a-pc-or-mac'
    }),
    hancomWriter: Object.freeze({
      officialInstallerUrl: 'https://download.hancom.com/support/downloadCenter/download'
    }),
    hancomCell: Object.freeze({
      officialInstallerUrl: 'https://download.hancom.com/support/downloadCenter/download'
    }),
    libreOffice: Object.freeze({
      wingetId: 'TheDocumentFoundation.LibreOffice',
      wingetVersion: '26.8.0.3',
      installerSha256: '4aa6c6e1895f4055104effcb556bd3362d20c6ad707c149543304f395ef9db95'
    }),
    rhwp: Object.freeze({
      pinnedRelease: Object.freeze({
        version: '0.8.4',
        platform: 'win32',
        architecture: 'x64',
        fileName: 'rhwp-v0.8.4-windows-x86_64.zip',
        url: 'https://github.com/edwardkim/rhwp/releases/download/v0.8.4/rhwp-v0.8.4-windows-x86_64.zip',
        sha256: 'e65b3e220573b18e1588768c5a16684eb89b2daf2488768575444cb83cd1b8c6',
        executableSha256: '56c26d809b1e09310b34c6c8449eacf97b8dd00b164aa25262e3c08f99f1093d'
      })
    })
  }),
  fonts: Object.freeze([
    Object.freeze({
      family: 'Noto Sans KR',
      verified: true,
      license: 'OFL-1.1',
      version: 'google-fonts-ade3d153',
      copyright: "(c) 2014-2021 Adobe, with Reserved Font Name 'Source'.",
      licenseAsset: Object.freeze({
        fileName: 'OFL.txt',
        url: 'https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl/notosanskr/OFL.txt',
        sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9'
      }),
      files: Object.freeze([
        Object.freeze({
          fileName: 'NotoSansKR[wght].ttf',
          style: 'Regular',
          url: 'https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf',
          sha256: '194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252'
        })
      ])
    }),
    Object.freeze({
      family: 'Noto Serif KR',
      verified: true,
      license: 'OFL-1.1',
      version: 'google-fonts-ade3d153',
      copyright: '(c) 2017-2024 Adobe.',
      licenseAsset: Object.freeze({
        fileName: 'OFL.txt',
        url: 'https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl/notoserifkr/OFL.txt',
        sha256: '5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6'
      }),
      files: Object.freeze([
        Object.freeze({
          fileName: 'NotoSerifKR[wght].ttf',
          style: 'Regular',
          url: 'https://raw.githubusercontent.com/google/fonts/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf',
          sha256: '11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3'
        })
      ])
    })
  ])
});
