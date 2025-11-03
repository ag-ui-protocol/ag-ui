/*
 * Copyright 2016 flipkart.com zjsonpatch.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

package com.agui.client.jsonpatch

import com.agui.client.jsonpatch.lcs.ListUtils
import kotlinx.serialization.json.*
import kotlin.jvm.JvmStatic
import kotlin.math.min

object JsonDiff {
    internal var op = Operations()
    internal var consts = Constants()


    @JvmStatic
    fun asJson(source: JsonElement, target: JsonElement): JsonArray {
        val diffs = ArrayList<Diff>()
        val path = ArrayList<Any>()
        /*
         * generating diffs in the order of their occurrence
         */
        generateDiffs(diffs, path, source, target)
        /*
         * Merging remove & add to move operation
         */
        compactDiffs(diffs)
        /*
         * Introduce copy operation
         */
        introduceCopyOperation(source, target, diffs)

        return getJsonNodes(diffs)
    }

    private fun getMatchingValuePath(unchangedValues: Map<JsonElement, List<Any>>, value: JsonElement): List<Any>? {
        return unchangedValues[value]
    }

    private fun introduceCopyOperation(source: JsonElement, target: JsonElement, diffs: MutableList<Diff>) {
        val unchangedValues = getUnchangedPart(source, target)
        for (i in diffs.indices) {
            val diff = diffs[i]
            if (op.ADD==diff.operation) {
                val matchingValuePath = getMatchingValuePath(unchangedValues, diff.value)
                if (matchingValuePath != null) {
                    diffs[i] = Diff(op.COPY, matchingValuePath, diff.path)
                }
            }
        }
    }

    private fun getUnchangedPart(source: JsonElement, target: JsonElement): Map<JsonElement, List<Any>> {
        val unchangedValues = HashMap<JsonElement, List<Any>>()
        computeUnchangedValues(unchangedValues, listOf(), source, target)
        return unchangedValues
    }

    private fun computeUnchangedValues(unchangedValues: MutableMap<JsonElement, List<Any>>, path: List<Any>, source: JsonElement, target: JsonElement) {
        if (source == target) {
            unchangedValues.put(target, path)
            return
        }

        val firstType = NodeType.getNodeType(source)
        val secondType = NodeType.getNodeType(target)

        if (firstType == secondType) {
            when (firstType) {
                NodeType.OBJECT -> computeObject(unchangedValues, path, source.jsonObject, target.jsonObject)
                NodeType.ARRAY -> computeArray(unchangedValues, path, source.jsonArray, target.jsonArray)
            }/* nothing */
        }
    }

    private fun computeArray(unchangedValues: MutableMap<JsonElement, List<Any>>, path: List<Any>, source: JsonArray, target: JsonArray) {
        val size = min(source.size, target.size)

        for (i in 0..size - 1) {
            val currPath = getPath(path, i)
            computeUnchangedValues(unchangedValues, currPath, source.get(i), target.get(i))
        }
    }

    private fun computeObject(unchangedValues: MutableMap<JsonElement, List<Any>>, path: List<Any>, source: JsonObject, target: JsonObject) {
        //val firstFields = source.entrySet().iterator()
        val firstFields = source.iterator()
        while (firstFields.hasNext()) {
            val name = firstFields.next().key
            if (target.containsKey(name)) {
                val currPath = getPath(path, name)
                computeUnchangedValues(unchangedValues, currPath, source.get(name)!!, target.get(name)!!)
            }
        }
    }

    /**
     * This method merge 2 diffs ( remove then add, or vice versa ) with same value into one Move operation,
     * all the core logic resides here only
     */
    private fun compactDiffs(diffs: MutableList<Diff>) {
        var i=-1
        while (++i <=diffs.size-1) {
            val diff1 = diffs[i]

            // if not remove OR add, move to next diff
            if (!(op.REMOVE==diff1.operation || op.ADD==diff1.operation)) {
                continue
            }

            for (j in i + 1..diffs.size - 1) {
                val diff2 = diffs[j]
                if (diff1.value != diff2.value) {
                    continue
                }

                var moveDiff: Diff? = null
                if (op.REMOVE==diff1.operation && op.ADD==diff2.operation) {
                    computeRelativePath(diff2.path, i + 1, j - 1, diffs)
                    moveDiff = Diff(op.MOVE, diff1.path, diff2.path)

                } else if (op.ADD==diff1.operation && op.REMOVE==diff2.operation) {
                    computeRelativePath(diff2.path, i, j - 1, diffs) // diff1's add should also be considered
                    moveDiff = Diff(op.MOVE, diff2.path, diff1.path)
                }
                if (moveDiff != null) {
                    diffs.removeAt(j)
                    diffs[i] = moveDiff
                    break
                }
            }
        }
    }

    //Note : only to be used for arrays
    //Finds the longest common Ancestor ending at Array
    private fun computeRelativePath(path: MutableList<Any>, startIdx: Int, endIdx: Int, diffs: List<Diff>) {
        val counters = ArrayList<Int>()

        resetCounters(counters, path.size)

        for (i in startIdx..endIdx) {
            val diff = diffs[i]
            //Adjust relative path according to #ADD and #Remove
            if (op.ADD==diff.operation || op.REMOVE==diff.operation) {
                updatePath(path, diff, counters)
            }
        }
        updatePathWithCounters(counters, path)
    }

    private fun resetCounters(counters: MutableList<Int>, size: Int) {
        for (i in 0..size - 1) {
            counters.add(0)
        }
    }

    private fun updatePathWithCounters(counters: List<Int>, path: MutableList<Any>) {
        for (i in counters.indices) {
            val value = counters[i]
            if (value != 0) {
                val currValue = path[i].toString().toInt()
                path[i] = (currValue + value).toString()
            }
        }
    }

    private fun updatePath(path: List<Any>, pseudo: Diff, counters: MutableList<Int>) {
        //find longest common prefix of both the paths

        if (pseudo.path.size <= path.size) {
            var idx = -1
            for (i in 0..pseudo.path.size - 1 - 1) {
                if (pseudo.path[i] == path[i]) {
                    idx = i
                } else {
                    break
                }
            }
            if (idx == pseudo.path.size - 2) {
                if (pseudo.path[pseudo.path.size - 1] is Int) {
                    updateCounters(pseudo, pseudo.path.size - 1, counters)
                }
            }
        }
    }

    private fun updateCounters(pseudo: Diff, idx: Int, counters: MutableList<Int>) {
        if (op.ADD==pseudo.operation) {
            counters[idx] = counters[idx] - 1
        } else {
            if (op.REMOVE==pseudo.operation) {
                counters[idx] = counters[idx] + 1
            }
        }
    }

    private fun getJsonNodes(diffs: List<Diff>): JsonArray {
        var patch = JsonArray(emptyList())
        for (diff in diffs) {
            val jsonNode = getJsonNode(diff)
            patch = patch.add(jsonNode)
        }
        return patch
    }

    private fun getJsonNode(diff: Diff): JsonObject {
        var jsonNode = JsonObject(emptyMap())
        jsonNode = jsonNode.addProperty(consts.OP, op.nameFromOp(diff.operation))
        if (op.MOVE==diff.operation || op.COPY==diff.operation) {
            jsonNode = jsonNode.addProperty(consts.FROM, getArrayNodeRepresentation(diff.path)) //required {from} only in case of Move Operation
            jsonNode = jsonNode.addProperty(consts.PATH, getArrayNodeRepresentation(diff.toPath))  // destination Path
        } else {
            jsonNode = jsonNode.addProperty(consts.PATH, getArrayNodeRepresentation(diff.path))
            jsonNode = jsonNode.add(consts.VALUE, diff.value)
        }
        return jsonNode
    }


    private fun EncodePath(`object`: Any): String {
        val path = `object`.toString() // see http://tools.ietf.org/html/rfc6901#section-4
        return path.replace("~".toRegex(), "~0").replace("/".toRegex(), "~1")
    }
    //join path parts in argument 'path', inserting a '/' between joined elements, starting with '/' and transforming the element of the list with ENCODE_PATH_FUNCTION
    private fun getArrayNodeRepresentation(path: List<Any>): String {
        //        return Joiner.on('/').appendTo(new StringBuilder().append('/'),
        //                Iterables.transform(path, ENCODE_PATH_FUNCTION)).toString();
        val sb = StringBuilder()
        for (i in path.indices) {
            sb.append('/')
            sb.append(EncodePath(path[i]))

        }
        return sb.toString()
    }



    private fun generateDiffs(diffs: MutableList<Diff>, path: List<Any>, source: JsonElement, target: JsonElement) {
        if (source != target) {
            val sourceType = NodeType.getNodeType(source)
            val targetType = NodeType.getNodeType(target)

            if (sourceType == NodeType.ARRAY && targetType == NodeType.ARRAY) {
                //both are arrays
                compareArray(diffs, path, source.jsonArray, target.jsonArray)
            } else if (sourceType == NodeType.OBJECT && targetType == NodeType.OBJECT) {
                //both are json
                compareObjects(diffs, path, source.jsonObject, target.jsonObject)
            } else {
                //can be replaced

                diffs.add(Diff.generateDiff(op.REPLACE, path, target))
            }
        }
    }

    private fun compareArray(diffs: MutableList<Diff>, path: List<Any>, source: JsonArray, target: JsonArray) {
        val lcs = getLCS(source, target)
        var srcIdx = 0
        var targetIdx = 0
        var lcsIdx = 0
        val srcSize = source.size
        val targetSize = target.size
        val lcsSize = lcs.size

        var pos = 0
        while (lcsIdx < lcsSize) {
            val lcsNode = lcs[lcsIdx]
            val srcNode = source.get(srcIdx)
            val targetNode = target.get(targetIdx)


            if (lcsNode == srcNode && lcsNode == targetNode) { // Both are same as lcs node, nothing to do here
                srcIdx++
                targetIdx++
                lcsIdx++
                pos++
            } else {
                if (lcsNode == srcNode) { // src node is same as lcs, but not targetNode
                    //addition
                    val currPath = getPath(path, pos)
                    diffs.add(Diff.generateDiff(op.ADD, currPath, targetNode))
                    pos++
                    targetIdx++
                } else if (lcsNode == targetNode) { //targetNode node is same as lcs, but not src
                    //removal,
                    val currPath = getPath(path, pos)
                    diffs.add(Diff.generateDiff(op.REMOVE, currPath, srcNode))
                    srcIdx++
                } else {
                    val currPath = getPath(path, pos)
                    //both are unequal to lcs node
                    generateDiffs(diffs, currPath, srcNode, targetNode)
                    srcIdx++
                    targetIdx++
                    pos++
                }
            }
        }

        while (srcIdx < srcSize && targetIdx < targetSize) {
            val srcNode = source.get(srcIdx)
            val targetNode = target.get(targetIdx)
            val currPath = getPath(path, pos)
            generateDiffs(diffs, currPath, srcNode, targetNode)
            srcIdx++
            targetIdx++
            pos++
        }
        pos = addRemaining(diffs, path, target, pos, targetIdx, targetSize)
        removeRemaining(diffs, path, pos, srcIdx, srcSize, source)
    }

    private fun removeRemaining(diffs: MutableList<Diff>, path: List<Any>, pos: Int, srcIdx_: Int, srcSize: Int, source_: JsonElement): Int {
        var srcIdx = srcIdx_
        val source = source_.jsonArray
        while (srcIdx < srcSize) {
            val currPath = getPath(path, pos)
            diffs.add(Diff.generateDiff(op.REMOVE, currPath, source.get(srcIdx)))
            srcIdx++
        }
        return pos
    }

    private fun addRemaining(diffs: MutableList<Diff>, path: List<Any>, target_: JsonElement, pos_: Int, targetIdx_: Int, targetSize: Int): Int {
        var pos = pos_
        var targetIdx = targetIdx_
        val target = target_.jsonArray
        while (targetIdx < targetSize) {
            val jsonNode = target.get(targetIdx)
            val currPath = getPath(path, pos)
            diffs.add(Diff.generateDiff(op.ADD, currPath, jsonNode.deepCopy()))
            pos++
            targetIdx++
        }
        return pos
    }

    private fun compareObjects(diffs: MutableList<Diff>, path: List<Any>, source: JsonObject, target: JsonObject) {
        val keysFromSrc = source.iterator()
        while (keysFromSrc.hasNext()) {
            val key = keysFromSrc.next().key
            if (!target.containsKey(key)) {
                //remove case
                val currPath = getPath(path, key)
                diffs.add(Diff.generateDiff(op.REMOVE, currPath, source.get(key)!!))
                continue
            }
            val currPath = getPath(path, key)
            generateDiffs(diffs, currPath, source.get(key)!!, target.get(key)!!)
        }
        val keysFromTarget = target.iterator()
        while (keysFromTarget.hasNext()) {
            val key = keysFromTarget.next().key
            if (!source.containsKey(key)) {
                //add case
                val currPath = getPath(path, key)
                diffs.add(Diff.generateDiff(op.ADD, currPath, target.get(key)!!))
            }
        }
    }

    private fun getPath(path: List<Any>, key: Any): List<Any> {
        val toReturn = ArrayList<Any>()
        toReturn.addAll(path)
        toReturn.add(key)
        return toReturn
    }

    private fun getLCS(first_: JsonElement, second_: JsonElement): List<JsonElement> {
        if (first_ !is JsonArray) throw IllegalArgumentException("LCS can only work on JSON arrays")
        if (second_ !is JsonArray) throw IllegalArgumentException("LCS can only work on JSON arrays")
        val first = first_ as JsonArray
        val second = second_ as JsonArray
        return ListUtils.longestCommonSubsequence(first.toList(),second.toList())
    }
}


