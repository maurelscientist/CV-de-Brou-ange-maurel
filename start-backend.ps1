# Script de lancement du backend Lynda (assistante IA)
# Usage : .\start-backend.ps1
# Le serveur Node ecoute sur http://127.0.0.1:5000
$ErrorActionPreference = 'Stop'
$backendDir = Join-Path $PSScriptRoot 'backend'

# Force l'encodage UTF-8 pour un affichage correct des accents
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Verifie si le port 5000 est deja utilise
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', 5000)
    $tcp.Close()
    Write-Host "Le backend Lynda tourne deja sur http://127.0.0.1:5000" -ForegroundColor Green
    exit 0
} catch {
    # Port libre, on continue
}

Write-Host "Demarrage du backend Lynda sur http://127.0.0.1:5000 ..." -ForegroundColor Cyan
Set-Location $backendDir
node server.js
