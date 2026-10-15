let arr = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16]
]

let top = 0
let bottom = arr.length - 1
let left = 0
let right = arr[0].length - 1

let ans = []

while (top <= bottom && left <= right) {
    for (let j = left; j <= right; j++) {
        ans.push(arr[top][j])
    }
    top++

    for (let i = top; i <= bottom; i++) {
        ans.push(arr[i][right])
    }
    right--

    if (top <= bottom) {
        for (let j = right; j >= left; j--) {
            ans.push(arr[bottom][j])
        }
        bottom--
    }

    if (left <= right) {
        for (let i = bottom; i >= top; i--) {
            ans.push(arr[i][left])
        }
        left++
    }
}

console.log(ans)