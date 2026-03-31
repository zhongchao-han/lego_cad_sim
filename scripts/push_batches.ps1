$files = Get-ChildItem -Path data/custom_assets/thumbnails -Filter *.png
$batchSize = 400
for ($i = 0; $i -lt $files.Count; $i += $batchSize) {
    $batchNum = [math]::Floor($i/$batchSize) + 1
    Write-Host "Staging Batch $batchNum"
    $batch = $files[$i..($i+$batchSize-1)]
    foreach ($file in $batch) {
        if ($file) {
            git add $file.FullName
        }
    }
    git commit -m "chore: commit thumbnails batch $batchNum"
    Write-Host "Pushing Batch $batchNum..."
    git push
}
Write-Host "All Batches Pushed Successfully!"
