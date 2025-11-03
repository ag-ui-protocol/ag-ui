package com.agui.client.jsonpatch.lcs

import kotlin.jvm.JvmOverloads

/*
* Licensed to the Apache Software Foundation (ASF) under one or more
* contributor license agreements.  See the NOTICE file distributed with
* this work for additional information regarding copyright ownership.
* The ASF licenses this file to You under the Apache License, Version 2.0
* (the "License"); you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*      http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
/**
 * This class allows to compare two objects sequences.
 *
 *
 * The two sequences can hold any object type, as only the `equals`
 * method is used to compare the elements of the sequences. It is guaranteed
 * that the comparisons will always be done as `o1.equals(o2)` where
 * `o1` belongs to the first sequence and `o2` belongs to
 * the second sequence. This can be important if subclassing is used for some
 * elements in the first sequence and the `equals` method is
 * specialized.
 *
 *
 * Comparison can be seen from two points of view: either as giving the smallest
 * modification allowing to transform the first sequence into the second one, or
 * as giving the longest sequence which is a subsequence of both initial
 * sequences. The `equals` method is used to compare objects, so any
 * object can be put into sequences. Modifications include deleting, inserting
 * or keeping one object, starting from the beginning of the first sequence.
 *
 *
 * This class implements the comparison algorithm, which is the very efficient
 * algorithm from Eugene W. Myers
 * [
 * An O(ND) Difference Algorithm and Its Variations](http://www.cis.upenn.edu/~bcpierce/courses/dd/papers/diff.ps). This algorithm produces
 * the shortest possible
 * [edit script][EditScript]
 * containing all the
 * [commands][EditCommand]
 * needed to transform the first sequence into the second one.
 *
 * @see EditScript
 *
 * @see EditCommand
 *
 * @see CommandVisitor
 *
 *
 * @since 4.0
 * @version $Id: SequencesComparator.java 1540567 2013-11-10 22:19:29Z tn $
 */

class SequencesComparator<T> @JvmOverloads constructor(
//class SequencesComparator<T> constructor(
sequence1: List<T>,
sequence2: List<T>,
equator: Equator<in T> = DefaultEquator.defaultEquator()
) {
    /** First sequence.  */
    private val sequence1: List<T>

    /** Second sequence.  */
    private val sequence2: List<T>

    /** The equator used for testing object equality.  */
    private val equator: Equator<in T>

    /** Temporary variables.  */
    private val vDown: IntArray
    private val vUp: IntArray
    /**
     * Simple constructor.
     *
     *
     * Creates a new instance of SequencesComparator with a custom [Equator].
     *
     *
     * It is *guaranteed* that the comparisons will always be done as
     * `Equator.equate(o1, o2)` where `o1` belongs to the first
     * sequence and `o2` belongs to the second sequence.
     *
     * @param sequence1  first sequence to be compared
     * @param sequence2  second sequence to be compared
     * @param equator  the equator to use for testing object equality
     */
    /**
     * Simple constructor.
     *
     *
     * Creates a new instance of SequencesComparator using a [DefaultEquator].
     *
     *
     * It is *guaranteed* that the comparisons will always be done as
     * `o1.equals(o2)` where `o1` belongs to the first
     * sequence and `o2` belongs to the second sequence. This can be
     * important if subclassing is used for some elements in the first sequence
     * and the `equals` method is specialized.
     *
     * @param sequence1  first sequence to be compared
     * @param sequence2  second sequence to be compared
     */
    init {
        this.sequence1 = sequence1
        this.sequence2 = sequence2
        this.equator = equator
        val size = sequence1.size + sequence2.size + 2
        vDown = IntArray(size)
        vUp = IntArray(size)
    }

    /**
     * Get the [EditScript] object.
     *
     *
     * It is guaranteed that the objects embedded in the [ insert commands][InsertCommand] come from the second sequence and that the objects
     * embedded in either the [delete commands][DeleteCommand] or
     * [keep commands][KeepCommand] come from the first sequence. This can
     * be important if subclassing is used for some elements in the first
     * sequence and the `equals` method is specialized.
     *
     * @return the edit script resulting from the comparison of the two
     * sequences
     */
    fun getScript(): EditScript<T> {
        val script = EditScript<T>()
        buildScript(0, sequence1.size, 0, sequence2.size, script)
        return script
    }

    /**
     * Build a snake.
     *
     * @param start  the value of the start of the snake
     * @param diag  the value of the diagonal of the snake
     * @param end1  the value of the end of the first sequence to be compared
     * @param end2  the value of the end of the second sequence to be compared
     * @return the snake built
     */
    private fun buildSnake(start: Int, diag: Int, end1: Int, end2: Int): Snake {
        var end = start
        while (end - diag < end2 && end < end1 && equator.equate(
                sequence1[end],
                sequence2[end - diag]
            )
        ) {
            ++end
        }
        return Snake(start, end, diag)
    }

    /**
     * Get the middle snake corresponding to two subsequences of the
     * main sequences.
     *
     *
     * The snake is found using the MYERS Algorithm (this algorithms has
     * also been implemented in the GNU diff program). This algorithm is
     * explained in Eugene Myers article:
     * [
 * An O(ND) Difference Algorithm and Its Variations](http://www.cs.arizona.edu/people/gene/PAPERS/diff.ps).
     *
     * @param start1  the begin of the first sequence to be compared
     * @param end1  the end of the first sequence to be compared
     * @param start2  the begin of the second sequence to be compared
     * @param end2  the end of the second sequence to be compared
     * @return the middle snake
     */
    private fun getMiddleSnake(start1: Int, end1: Int, start2: Int, end2: Int): Snake? {
        // Myers Algorithm
        // Initialisations
        val m = end1 - start1
        val n = end2 - start2
        if (m == 0 || n == 0) {
            return null
        }
        val delta = m - n
        val sum = n + m
        val offset = (if (sum % 2 == 0) sum else sum + 1) / 2
        vDown[1 + offset] = start1
        vUp[1 + offset] = end1 + 1
        for (d in 0..offset) {
            // Down
            run {
                var k = -d
                while (k <= d) {

                    // First step
                    val i = k + offset
                    if (k == -d || k != d && vDown[i - 1] < vDown[i + 1]) {
                        vDown[i] = vDown[i + 1]
                    } else {
                        vDown[i] = vDown[i - 1] + 1
                    }
                    var x = vDown[i]
                    var y = x - start1 + start2 - k
                    while (x < end1 && y < end2 && equator.equate(
                            sequence1[x],
                            sequence2[y]
                        )
                    ) {
                        vDown[i] = ++x
                        ++y
                    }
                    // Second step
                    if (delta % 2 != 0 && delta - d <= k && k <= delta + d) {
                        if (vUp[i - delta] <= vDown[i]) {
                            return buildSnake(vUp[i - delta], k + start1 - start2, end1, end2)
                        }
                    }
                    k += 2
                }
            }

            // Up
            var k = delta - d
            while (k <= delta + d) {

                // First step
                val i = k + offset - delta
                if (k == delta - d
                    || k != delta + d && vUp[i + 1] <= vUp[i - 1]
                ) {
                    vUp[i] = vUp[i + 1] - 1
                } else {
                    vUp[i] = vUp[i - 1]
                }
                var x = vUp[i] - 1
                var y = x - start1 + start2 - k
                while (x >= start1 && y >= start2 && equator.equate(sequence1[x], sequence2[y])) {
                    vUp[i] = x--
                    y--
                }
                // Second step
                if (delta % 2 == 0 && -d <= k && k <= d) {
                    if (vUp[i] <= vDown[i + delta]) {
                        return buildSnake(vUp[i], k + start1 - start2, end1, end2)
                    }
                }
                k += 2
            }
        }
        throw RuntimeException("Internal Error")
    }

    /**
     * Build an edit script.
     *
     * @param start1  the begin of the first sequence to be compared
     * @param end1  the end of the first sequence to be compared
     * @param start2  the begin of the second sequence to be compared
     * @param end2  the end of the second sequence to be compared
     * @param script the edited script
     */
    private fun buildScript(
        start1: Int, end1: Int, start2: Int, end2: Int,
        script: EditScript<T>
    ) {
        val middle = getMiddleSnake(start1, end1, start2, end2)
        if (middle == null || (middle.start == end1 && middle.diag == end1 - end2) || (middle.end == start1 && middle.diag == start1 - start2)) {
            var i = start1
            var j = start2
            while (i < end1 || j < end2) {
                if (i < end1 && j < end2 && equator.equate(sequence1[i], sequence2[j])) {
                    script.append(KeepCommand(sequence1[i]))
                    ++i
                    ++j
                } else {
                    if (end1 - start1 > end2 - start2) {
                        script.append(DeleteCommand(sequence1[i]))
                        ++i
                    } else {
                        script.append(InsertCommand(sequence2[j]))
                        ++j
                    }
                }
            }
        } else {
            buildScript(
                start1, middle.start,
                start2, middle.start - middle.diag,
                script
            )
            for (i in middle.start until middle.end) {
                script.append(KeepCommand(sequence1[i]))
            }
            buildScript(
                middle.end, end1,
                middle.end - middle.diag, end2,
                script
            )
        }
    }
    /**
     * This class is a simple placeholder to hold the end part of a path
     * under construction in a [SequencesComparator].
     */


    private class Snake
    /**
     * Simple constructor. Creates a new instance of Snake with specified indices.
     *
     * @param start  start index of the snake
     * @param end  end index of the snake
     * @param diag  diagonal number
     */(
        /** Start index.  */
        val start: Int,
        /** End index.  */
        val end: Int,
        /** Diagonal number.  */
        val diag: Int
    ) {
        /**
         * Get the start index of the snake.
         *
         * @return start index of the snake
         */
        /**
         * Get the end index of the snake.
         *
         * @return end index of the snake
         */
        /**
         * Get the diagonal number of the snake.
         *
         * @return diagonal number of the snake
         */

    }
}
